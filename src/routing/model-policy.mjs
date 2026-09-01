import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeRequestPolicies, normalizeRequestPolicy } from './request-policy.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PATH = join(PROJECT_ROOT, 'config', 'models.json');

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

const THINKING_ADAPTERS = new Set([
  'none',
  'glm_disabled',
  'deepseek_disabled',
  'longcat_disabled',
  'minimax_split',
  'kimi_low',
]);

const CANDIDATE_STRATEGIES = new Set(['fair', 'ordered', 'adaptive']);

export function loadModelPolicy({ path = DEFAULT_PATH } = {}) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion !== 1) {
    throw new Error('model-policy schemaVersion must be 1');
  }
  return compilePolicy(raw);
}

export function realModelPolicy(policy, modelName) {
  return policy.realModels.get(normalizeName(modelName)) || null;
}

export function resolveLogicalRequest(policy, requestedModel, taskName = '') {
  const logical = policy.logicalModels.get(normalizeName(requestedModel));
  if (!logical) return null;

  const normalizedTask = normalizeName(taskName);
  const subtype = normalizedTask ? policy.taskSubtypes.get(normalizedTask) : null;
  if (normalizedTask && (!subtype || !logical.allowedTaskSubtypes.has(normalizedTask))) {
    throw new Error(`logical model ${logical.name} does not allow task subtype ${taskName}`);
  }

  const selected = subtype || logical;
  return Object.freeze({
    logicalModel: logical.name,
    taskName: subtype ? subtype.name : '',
    candidates: selected.candidates,
    maxAttempts: selected.maxAttempts ?? logical.maxAttempts,
    deadlineMs: selected.deadlineMs ?? logical.deadlineMs,
    logicalAdmissionWaitMs: selected.logicalAdmissionWaitMs ?? logical.logicalAdmissionWaitMs ?? 0,
    requiredCapabilities: Object.freeze([
      ...new Set([
        ...logical.requiredCapabilities,
        ...(subtype?.requiredCapabilities || []),
      ]),
    ]),
    qualityTier: subtype?.qualityTier || logical.qualityTier || '',
    sessionAffinity: subtype?.sessionAffinity ?? logical.sessionAffinity,
    allowWeakFallback: subtype?.allowWeakFallback ?? logical.allowWeakFallback,
    protected: subtype?.protected ?? logical.protected,
    minReadySlots: subtype?.minReadySlots ?? logical.minReadySlots ?? 0,
    maxInflight: subtype?.maxInflight ?? logical.maxInflight,
    preferDifferentFromPrevious: subtype?.preferDifferentFromPrevious
      ?? logical.preferDifferentFromPrevious,
    candidateStrategy: subtype?.candidateStrategy ?? logical.candidateStrategy ?? 'fair',
    requestPolicy: mergeRequestPolicies(logical.requestPolicy, subtype?.requestPolicy),
  });
}

function compilePolicy(raw) {
  const realModels = compileNamedMap(raw.realModels, 'real model', compileRealModel);
  const taskSubtypes = compileNamedMap(
    raw.taskSubtypes || {},
    'task subtype',
    (name, value) => compileRoute(name, value, realModels, { requireMaxInflight: false }),
    { allowEmpty: true },
  );
  const logicalModels = compileNamedMap(
    raw.logicalModels,
    'logical model',
    (name, value) => compileLogicalModel(name, value, realModels, taskSubtypes),
  );

  const allowedSubtypes = new Set();
  for (const logical of logicalModels.values()) {
    for (const subtype of logical.allowedTaskSubtypes) allowedSubtypes.add(subtype);
  }
  for (const subtype of taskSubtypes.keys()) {
    if (!allowedSubtypes.has(subtype)) {
      throw new Error(`task subtype ${subtype} is not allowed by any logical model`);
    }
  }

  return Object.freeze({ schemaVersion: 1, realModels, taskSubtypes, logicalModels });
}

function compileNamedMap(raw, label, compile, { allowEmpty = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}s must be an object`);
  }
  const map = new Map();
  for (const [name, value] of Object.entries(raw)) {
    const key = normalizeName(name);
    if (!key) throw new Error(`${label} name must not be empty`);
    if (map.has(key)) throw new Error(`duplicate case-insensitive ${label} name: ${name}`);
    map.set(key, compile(name, value || {}));
  }
  if (!allowEmpty && map.size === 0) throw new Error(`${label}s must not be empty`);
  return map;
}

function compileRealModel(name, value) {
  const qualityTier = requireString(value.qualityTier, `${name}.qualityTier`);
  const thinkingAdapter = requireString(value.thinkingAdapter, `${name}.thinkingAdapter`);
  if (!THINKING_ADAPTERS.has(thinkingAdapter)) {
    throw new Error(`${name}.thinkingAdapter has unknown adapter ${thinkingAdapter}`);
  }
  return Object.freeze({
    name,
    qualityTier,
    capabilities: normalizeCapabilities(value.capabilities, `${name}.capabilities`),
    thinkingAdapter,
    maxTokensMultiplier: value.maxTokensMultiplier == null
      ? 1
      : requireAtLeastOne(value.maxTokensMultiplier, `${name}.maxTokensMultiplier`),
    maxInflight: requirePositiveInteger(value.maxInflight, `${name}.maxInflight`),
    initialLatencyMs: requirePositive(value.initialLatencyMs, `${name}.initialLatencyMs`),
    firstByteTimeoutMs: requirePositive(value.firstByteTimeoutMs, `${name}.firstByteTimeoutMs`),
    totalTimeoutMs: requirePositive(value.totalTimeoutMs, `${name}.totalTimeoutMs`),
    standaloneOnly: value.standaloneOnly === true,
  });
}

function compileLogicalModel(name, value, realModels, taskSubtypes) {
  const route = compileRoute(name, value, realModels, { requireMaxInflight: true });
  const allowed = normalizeNames(value.allowedTaskSubtypes || [], `${name}.allowedTaskSubtypes`);
  for (const subtype of allowed) {
    if (!taskSubtypes.has(subtype)) {
      throw new Error(`${name}.allowedTaskSubtypes references unknown subtype ${subtype}`);
    }
    assertCandidatesSupportCapabilities(
      `${name}/${subtype}`,
      taskSubtypes.get(subtype).candidates,
      route.requiredCapabilities,
      realModels,
    );
  }
  return Object.freeze({
    ...route,
    allowedTaskSubtypes: new Set(allowed),
  });
}

function compileRoute(name, value, realModels, { requireMaxInflight }) {
  const candidates = normalizeNames(value.candidates, `${name}.candidates`, { preserveCase: true });
  for (const candidate of candidates) {
    const model = realModels.get(normalizeName(candidate));
    if (!model) {
      throw new Error(`${name}.candidates references unknown candidate model ${candidate}`);
    }
    if (model.standaloneOnly) {
      throw new Error(`${name}.candidates references standalone-only model ${candidate}`);
    }
  }
  const requiredCapabilities = normalizeCapabilities(
    value.requiredCapabilities || [],
    `${name}.requiredCapabilities`,
  );
  assertCandidatesSupportCapabilities(name, candidates, requiredCapabilities, realModels);
  const maxInflight = value.maxInflight == null && !requireMaxInflight
    ? undefined
    : requirePositiveInteger(value.maxInflight, `${name}.maxInflight`);
  return Object.freeze({
    name,
    candidates: Object.freeze(candidates),
    requiredCapabilities,
    qualityTier: value.qualityTier ? requireString(value.qualityTier, `${name}.qualityTier`) : '',
    maxAttempts: requirePositiveInteger(value.maxAttempts, `${name}.maxAttempts`),
    deadlineMs: requirePositive(value.deadlineMs, `${name}.deadlineMs`),
    logicalAdmissionWaitMs: value.logicalAdmissionWaitMs == null
      ? (requireMaxInflight ? 0 : undefined)
      : requireNonNegativeInteger(value.logicalAdmissionWaitMs, `${name}.logicalAdmissionWaitMs`),
    maxInflight,
    sessionAffinity: optionalRouteBoolean(value, 'sessionAffinity', requireMaxInflight, false),
    allowWeakFallback: optionalRouteBoolean(value, 'allowWeakFallback', requireMaxInflight, true),
    protected: optionalRouteBoolean(value, 'protected', requireMaxInflight, false),
    minReadySlots: value.minReadySlots == null
      ? (requireMaxInflight ? 0 : undefined)
      : requirePositiveInteger(value.minReadySlots, `${name}.minReadySlots`),
    preferDifferentFromPrevious: optionalRouteBoolean(
      value,
      'preferDifferentFromPrevious',
      requireMaxInflight,
      false,
    ),
    candidateStrategy: Object.hasOwn(value, 'candidateStrategy')
      ? requireCandidateStrategy(value.candidateStrategy, `${name}.candidateStrategy`)
      : undefined,
    requestPolicy: normalizeRequestPolicy(value.request, { label: `${name}.request` }),
  });
}

function assertCandidatesSupportCapabilities(name, candidates, requiredCapabilities, realModels) {
  for (const candidate of candidates) {
    const model = realModels.get(normalizeName(candidate));
    const missing = requiredCapabilities.filter(
      (capability) => !model.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new Error(
        `${name}.candidates model ${candidate} lacks required capabilities: ${missing.join(', ')}`,
      );
    }
  }
}

function normalizeCapabilities(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = [];
  for (const rawCapability of value) {
    const capability = normalizeName(rawCapability);
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw new Error(`${label} has invalid capability ${rawCapability}`);
    }
    if (!result.includes(capability)) result.push(capability);
  }
  return Object.freeze(result);
}

function normalizeNames(value, label, { preserveCase = false } = {}) {
  if (!Array.isArray(value) || value.length === 0 && !label.endsWith('allowedTaskSubtypes')) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = normalizeName(item);
    if (!normalized) throw new Error(`${label} must contain non-empty strings`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(preserveCase ? String(item).trim() : normalized);
  }
  return result;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string`);
  return value.trim();
}

function requirePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function requireNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function requireAtLeastOne(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error(`${label} must be at least 1`);
  return number;
}

function requireCandidateStrategy(value, label) {
  const strategy = requireString(value, label);
  if (!CANDIDATE_STRATEGIES.has(strategy)) {
    throw new Error(`${label} must be one of: fair, ordered, adaptive`);
  }
  return strategy;
}

function optionalRouteBoolean(value, field, requiredRoute, fallback) {
  if (!requiredRoute && !Object.hasOwn(value, field)) return undefined;
  if (!Object.hasOwn(value, field)) return fallback;
  if (typeof value[field] !== 'boolean') {
    throw new Error(`${field} must be boolean`);
  }
  return value[field];
}
