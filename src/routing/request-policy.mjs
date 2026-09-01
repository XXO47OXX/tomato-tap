const POLICY_FIELDS = Object.freeze([
  'reasoningEffort',
  'temperature',
  'stream',
  'maxOutputTokens',
  'maxInputTokens',
]);

const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
]);

export function normalizeRequestPolicy(value, { label = 'request' } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!POLICY_FIELDS.includes(field)) {
      throw new Error(`${label} has unknown field "${field}"`);
    }
  }

  const reasoningEffort = value.reasoningEffort == null
    ? null
    : String(value.reasoningEffort).trim().toLowerCase();
  if (reasoningEffort != null && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`${label}.reasoningEffort is invalid`);
  }

  let temperature = null;
  if (value.temperature != null) {
    temperature = Number(value.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`${label}.temperature must be a number between 0 and 2`);
    }
  }

  let stream = null;
  if (value.stream != null) {
    if (typeof value.stream !== 'boolean') {
      throw new Error(`${label}.stream must be boolean`);
    }
    stream = value.stream;
  }

  const maxOutputTokens = optionalPositiveInteger(
    value.maxOutputTokens,
    `${label}.maxOutputTokens`,
  );
  const maxInputTokens = optionalPositiveInteger(
    value.maxInputTokens,
    `${label}.maxInputTokens`,
  );

  return Object.freeze({
    reasoningEffort,
    temperature,
    stream,
    maxOutputTokens,
    maxInputTokens,
  });
}

export function mergeRequestPolicies(...policies) {
  const merged = {};
  let hasValue = false;
  for (const policy of policies) {
    if (!policy) continue;
    for (const field of POLICY_FIELDS) {
      if (policy[field] == null) continue;
      merged[field] = policy[field];
      hasValue = true;
    }
  }
  return hasValue ? normalizeRequestPolicy(merged) : null;
}

export function requestPolicyJSON(policy) {
  if (!policy) return null;
  const output = {};
  for (const field of POLICY_FIELDS) {
    if (policy[field] != null) output[field] = policy[field];
  }
  return Object.keys(output).length > 0 ? output : null;
}

function optionalPositiveInteger(value, label) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
