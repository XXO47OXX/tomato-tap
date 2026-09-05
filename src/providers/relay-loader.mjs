// relay-loader.mjs
//
// Loads non-secret relay metadata from ./relays.json and combines it with
// secret keys discovered from the process environment.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRequestPolicy as normalizeSharedRequestPolicy } from '../routing/request-policy.mjs';
import { normalizeFallbackAdmission } from '../routing/ordinary-fallback-policy.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PATH = join(PROJECT_ROOT, 'config', 'relays.json');
const SUPPORTED_SCHEMA = 1;

export function loadRelayRegistry(opts = {}) {
  const path = opts.path || DEFAULT_PATH;
  if (!opts.document && !existsSync(path)) {
    return { path, relays: {} };
  }
  const raw = opts.document || JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`relay-loader: unsupported schemaVersion ${raw.schemaVersion} (expected ${SUPPORTED_SCHEMA})`);
  }
  if (!raw.relays || typeof raw.relays !== 'object' || Array.isArray(raw.relays)) {
    throw new Error('relay-loader: relays must be an object');
  }
  const relays = {};
  for (const [slug, cfg] of Object.entries(raw.relays)) {
    if (!/^[a-z0-9._-]+$/i.test(slug)) {
      throw new Error(`relay-loader: invalid relay slug "${slug}"`);
    }
    relays[slug] = compileRelay(slug, cfg || {});
  }
  return { path, relays };
}

export function discoverRelayKeys(vendorName, envPrefix, env = process.env, registry = loadRelayRegistry()) {
  const out = [];
  for (const n of Object.keys(env).sort()) {
    const m = n.match(envPrefix);
    if (!m || !m[1]) continue;
    const slug = m[1];
    const canonicalEnvName = n.replace(/^mimotap_/i, 'tomato_tap_');
    // A canonical credential shadows its legacy alias instead of creating a
    // duplicate deployment with separate capacity and cooldown state.
    if (canonicalEnvName !== n && env[canonicalEnvName] !== undefined) continue;
    // Numbered Codewords keys share metadata but retain independent state.
    const meta = registry.relays[slug]
      || (slug.startsWith('codewords_') ? registry.relays.codewords_pool : null);
    if (!meta) {
      throw new Error(`relay-loader: missing metadata for relay "${slug}" in ${registry.path}`);
    }
    if (meta.disabled) {
      console.log(`[relay-discover] skipping disabled relay key "tomato_tap_relay_${slug}"`);
      continue;
    }
    const value = env[n];
    if (typeof value !== 'string' || value.length === 0) {
      console.warn(`[relay-discover] skipping tomato_tap_relay_${slug}: empty _key value`);
      continue;
    }
    const envBase = n.replace(/_key$/i, '');
    const fixedProxyUrl = normalizeFixedProxyUrl(slug, env[`${envBase}_proxy_url`]);
    const upstreamModelSet = meta.models.length > 0 ? new Set(meta.models) : null;
    const canonicalModelSet = meta.canonicalModels.length > 0
      ? new Set(meta.canonicalModels)
      : null;
    const modelSet = upstreamModelSet ? new Set(upstreamModelSet) : null;
    if (modelSet && canonicalModelSet) {
      for (const canonical of canonicalModelSet) modelSet.add(canonical);
    }
    out.push({
      deploymentId: meta.deploymentId,
      providerLabel: meta.providerLabel,
      name: `tomato_tap_relay_${slug}`,
      value,
      vendor: vendorName,
      host: meta.host,
      pathPrefix: meta.path,
      modelSet,
      upstreamModelSet,
      canonicalModelSet,
      modelAliases: meta.modelAliases,
      apiFormats: meta.apiFormats,
      authType: meta.authType,
      requestPolicy: meta.requestPolicy,
      rateLimitPolicy: meta.rateLimitPolicy,
      headers: meta.headers,
      proto: meta.proto,
      port: meta.port,
      capInitial: meta.capInitial,
      capMin: meta.capMin,
      capMax: meta.capMax,
      useProxy: meta.useProxy,
      proxyPolicy: meta.proxyPolicy,
      proxyUrl: fixedProxyUrl,
      proxyMode: fixedProxyUrl ? 'fixed-http' : undefined,
      baseWeight: meta.baseWeight,
      fallbackAdmission: meta.fallbackAdmission,
      quotaSignalProfile: meta.quotaSignalProfile,
      quotaPolicy: meta.quotaPolicy,
      expiresAtMs: meta.expiresAtMs,
    });
  }
  return out;
}

function normalizeFixedProxyUrl(slug, raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error(`relay-loader: relay "${slug}" has invalid _proxy_url`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`relay-loader: relay "${slug}" _proxy_url must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`relay-loader: relay "${slug}" _proxy_url credentials are not supported`);
  }
  return url.toString();
}

function compileRelay(slug, cfg) {
  const proxyPolicy = normalizeProxyPolicy(slug, cfg.proxy);
  const apiFormats = normalizeApiFormats(slug, cfg.apiFormats);
  const requestPolicy = normalizeRequestPolicy(slug, cfg.request);
  const rateLimitPolicy = normalizeRateLimitPolicy(slug, cfg.rateLimit);
  const models = normalizeModels(cfg.models);
  const modelAliases = normalizeAliases(slug, cfg.aliases);
  const canonicalModels = normalizeCanonicalModels(
    slug,
    models,
    modelAliases,
    cfg.canonicalModels,
  );
  if (cfg.disabled === true) {
    return {
      deploymentId: slug,
      providerLabel: normalizeProviderLabel(slug, cfg.provider),
      disabled: true,
      host: cfg.host || '',
      path: cfg.path || '',
      models,
      canonicalModels,
      proto: normalizeProto(slug, cfg.proto),
      port: normalizePort(slug, cfg.port, cfg.proto),
      modelAliases,
      apiFormats,
      authType: normalizeAuthType(slug, cfg.auth),
      requestPolicy,
      rateLimitPolicy,
      headers: normalizeHeaders(slug, cfg.headers),
      capInitial: normalizeCap(slug, cfg.cap, 'initial'),
      capMin: normalizeCap(slug, cfg.cap, 'min'),
      capMax: normalizeCap(slug, cfg.cap, 'max'),
      useProxy: proxyPolicy.mode === 'shared',
      proxyPolicy,
      baseWeight: normalizeWeight(slug, cfg.weight),
      fallbackAdmission: normalizeFallbackAdmission(cfg.fallbackAdmission),
      quotaSignalProfile: normalizeSignalProfile(slug, cfg.quotaSignalProfile),
      quotaPolicy: normalizeQuotaPolicy(slug, cfg.quota),
      expiresAtMs: normalizeExpiresAt(slug, cfg.expiresAt),
    };
  }
  if (typeof cfg.host !== 'string' || cfg.host.length === 0) {
    throw new Error(`relay-loader: relay "${slug}" requires host`);
  }
  return {
    deploymentId: slug,
    providerLabel: normalizeProviderLabel(slug, cfg.provider),
    disabled: false,
    host: cfg.host,
    path: typeof cfg.path === 'string' ? cfg.path : '',
    models,
    canonicalModels,
    proto: normalizeProto(slug, cfg.proto),
    port: normalizePort(slug, cfg.port, cfg.proto),
    modelAliases,
    apiFormats,
    authType: normalizeAuthType(slug, cfg.auth),
    requestPolicy,
    rateLimitPolicy,
    headers: normalizeHeaders(slug, cfg.headers),
    capInitial: normalizeCap(slug, cfg.cap, 'initial'),
    capMin: normalizeCap(slug, cfg.cap, 'min'),
    capMax: normalizeCap(slug, cfg.cap, 'max'),
    useProxy: proxyPolicy.mode === 'shared',
    proxyPolicy,
    baseWeight: normalizeWeight(slug, cfg.weight),
    fallbackAdmission: normalizeFallbackAdmission(cfg.fallbackAdmission),
    quotaSignalProfile: normalizeSignalProfile(slug, cfg.quotaSignalProfile),
    quotaPolicy: normalizeQuotaPolicy(slug, cfg.quota),
    expiresAtMs: normalizeExpiresAt(slug, cfg.expiresAt),
  };
}

function normalizeProviderLabel(slug, value) {
  if (value == null) return slug;
  if (typeof value !== 'string') {
    throw new Error(`relay-loader: relay "${slug}" provider must be a string`);
  }
  const label = value.trim();
  if (!label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error(
      `relay-loader: relay "${slug}" provider must be 1-128 printable characters`,
    );
  }
  return label;
}

export function normalizeCanonicalModels(slug, models, aliases, declared) {
  const normalizedModels = new Map(
    (models || []).map((model) => [String(model).toLowerCase(), model]),
  );
  if (declared != null) {
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new Error(
        `relay-loader: relay "${slug}" canonicalModels must be a non-empty string[]`,
      );
    }
    const canonical = new Map();
    for (const raw of declared) {
      const model = typeof raw === 'string' ? raw.trim() : '';
      const lower = model.toLowerCase();
      if (!lower) {
        throw new Error(
          `relay-loader: relay "${slug}" canonicalModels must contain non-empty strings`,
        );
      }
      if (!normalizedModels.has(lower) && !aliases?.has(lower)) {
        throw new Error(
          `relay-loader: relay "${slug}" canonical model "${model}" is neither an upstream model nor an alias`,
        );
      }
      canonical.set(lower, model);
    }
    return [...canonical.values()];
  }
  const aliasTargets = new Set();
  const canonical = new Map();
  for (const [client, upstream] of aliases || []) {
    const upstreamLower = String(upstream).toLowerCase();
    if (!normalizedModels.has(upstreamLower)) {
      throw new Error(
        `relay-loader: relay "${slug}" alias "${client}" targets unlisted model "${upstream}"`,
      );
    }
    aliasTargets.add(upstreamLower);
    canonical.set(String(client).toLowerCase(), client);
  }
  for (const model of models || []) {
    const lower = String(model).toLowerCase();
    if (!aliasTargets.has(lower)) canonical.set(lower, model);
  }
  return [...canonical.values()];
}

export function normalizeApiFormats(slug, value) {
  if (value == null) return new Set(['openai', 'anthropic']);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`relay-loader: relay "${slug}" apiFormats must be a non-empty string[]`);
  }
  const supported = new Set(['openai', 'anthropic']);
  const formats = new Set();
  for (const raw of value) {
    const format = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!supported.has(format)) {
      throw new Error(`relay-loader: relay "${slug}" has unsupported apiFormat "${raw}"`);
    }
    formats.add(format);
  }
  return formats;
}

export function normalizeAuthType(slug, value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== 'bearer' && normalized !== 'x-api-key') {
    throw new Error(`relay-loader: relay "${slug}" auth must be bearer or x-api-key`);
  }
  return normalized;
}

export function normalizeRequestPolicy(slug, value) {
  return normalizeSharedRequestPolicy(value, {
    label: `relay-loader: relay "${slug}" request`,
  });
}

export function normalizeRateLimitPolicy(slug, value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`relay-loader: relay "${slug}" rateLimit must be an object`);
  }
  const allowed = new Set(['requestsPerMinute', 'mode']);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`relay-loader: relay "${slug}" rateLimit has unknown field "${field}"`);
    }
  }
  const requestsPerMinute = Number(value.requestsPerMinute);
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1) {
    throw new Error(
      `relay-loader: relay "${slug}" rateLimit.requestsPerMinute must be a positive integer`,
    );
  }
  const mode = value.mode == null ? 'fixed-window' : String(value.mode).trim().toLowerCase();
  if (mode !== 'fixed-window' && mode !== 'paced') {
    throw new Error(
      `relay-loader: relay "${slug}" rateLimit.mode must be fixed-window or paced`,
    );
  }
  return Object.freeze({ requestsPerMinute, mode });
}

function normalizeHeaders(slug, value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`relay-loader: relay "${slug}" headers must be an object`);
  }
  const out = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName).trim();
    const lowered = name.toLowerCase();
    if (!lowered) {
      throw new Error(`relay-loader: relay "${slug}" header name cannot be empty`);
    }
    if (typeof rawValue !== 'string' && rawValue != null) {
      throw new Error(`relay-loader: relay "${slug}" header "${name}" value must be a string`);
    }
    out[name] = String(rawValue);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])),
  ));
}

export function normalizeExpiresAt(slug, value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'string') {
    throw new Error(`relay-loader: relay "${slug}" expiresAt must be an ISO-8601 string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`relay-loader: relay "${slug}" expiresAt is not a valid date`);
  }
  return parsed;
}

export function normalizeProxyPolicy(slug, value) {
  if (value == null || value === false) return { mode: 'direct', nodeId: null };
  if (value === true) return { mode: 'shared', nodeId: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`relay-loader: relay "${slug}" proxy must be boolean or object`);
  }
  const keys = Object.keys(value).sort();
  if (value.mode === 'sticky-auto' && keys.length === 1) {
    return { mode: 'sticky-auto', nodeId: null };
  }
  if (value.mode === 'sticky' && keys.length === 2
      && typeof value.node === 'string' && value.node.trim()) {
    return { mode: 'sticky', nodeId: value.node.trim() };
  }
  throw new Error(`relay-loader: relay "${slug}" has invalid proxy policy`);
}

function normalizeModels(models) {
  if (models == null) return [];
  if (!Array.isArray(models) || models.some((m) => typeof m !== 'string' || !m)) {
    throw new Error('relay-loader: models must be a string[] when present');
  }
  return [...models];
}

function normalizeProto(slug, proto) {
  const p = (proto || 'https').toLowerCase();
  if (p !== 'http' && p !== 'https') {
    throw new Error(`relay-loader: relay "${slug}" proto must be http or https`);
  }
  return p;
}

function normalizePort(slug, port, proto) {
  if (port == null || port === '') return normalizeProto(slug, proto) === 'http' ? 80 : 443;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`relay-loader: relay "${slug}" port must be 1..65535`);
  }
  return p;
}

function normalizeAliases(slug, aliases) {
  if (aliases == null) return null;
  if (typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error(`relay-loader: relay "${slug}" aliases must be an object`);
  }
  const map = new Map();
  for (const [client, upstream] of Object.entries(aliases)) {
    if (typeof upstream !== 'string' || !client || !upstream) {
      throw new Error(`relay-loader: relay "${slug}" aliases must map string to string`);
    }
    map.set(client.toLowerCase(), upstream);
  }
  return map.size > 0 ? map : null;
}

function normalizeCap(slug, cap, field) {
  if (!cap || cap[field] == null || cap[field] === '') return null;
  const v = Number(cap[field]);
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`relay-loader: relay "${slug}" cap.${field} must be a positive integer`);
  }
  return v;
}

function normalizeWeight(slug, weight) {
  if (weight == null || weight === '') return 1;
  const value = Number(weight);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`relay-loader: relay "${slug}" weight must be a positive number`);
  }
  return value;
}

function normalizeSignalProfile(slug, value) {
  if (value == null || value === '') return '';
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`relay-loader: relay "${slug}" quotaSignalProfile is invalid`);
  }
  return normalized;
}

export function normalizeQuotaPolicy(slug, value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`relay-loader: relay "${slug}" quota must be an object`);
  }
  const allowed = new Set([
    'initialState',
    'probeModel',
    'probeIntervalMs',
    'boostWindowMs',
    'boostWeight',
    'probeMaxTokens',
  ]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`relay-loader: relay "${slug}" quota has unknown field "${field}"`);
    }
  }
  if (value.initialState !== 'open' && value.initialState !== 'closed') {
    throw new Error(`relay-loader: relay "${slug}" quota.initialState must be open or closed`);
  }
  if (typeof value.probeModel !== 'string' || !value.probeModel.trim()) {
    throw new Error(`relay-loader: relay "${slug}" quota.probeModel must be a non-empty string`);
  }
  const positiveInteger = (field) => {
    const number = Number(value[field]);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`relay-loader: relay "${slug}" quota.${field} must be a positive integer`);
    }
    return number;
  };
  const boostWeight = Number(value.boostWeight);
  if (!Number.isFinite(boostWeight) || boostWeight <= 0) {
    throw new Error(`relay-loader: relay "${slug}" quota.boostWeight must be a positive number`);
  }
  return Object.freeze({
    initialState: value.initialState,
    probeModel: value.probeModel.trim(),
    probeIntervalMs: positiveInteger('probeIntervalMs'),
    boostWindowMs: positiveInteger('boostWindowMs'),
    boostWeight,
    probeMaxTokens: positiveInteger('probeMaxTokens'),
  });
}
