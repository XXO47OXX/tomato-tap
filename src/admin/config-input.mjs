// Untrusted console/API input normalization. No filesystem or runtime state is
// accessed here, which keeps validation deterministic and straightforward to
// audit.

const DEFAULT_REAL_MODEL = Object.freeze({
  qualityTier: 'standard',
  capabilities: ['instruction_following'],
  thinkingAdapter: 'none',
  maxInflight: 4,
  initialLatencyMs: 1_500,
  firstByteTimeoutMs: 120_000,
  totalTimeoutMs: 600_000,
});

const MANAGED_SETTING_NAMES = Object.freeze([
  'TOMATO_TAP_ADMIN_DETAIL_LEVEL',
  'TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS',
  'TOMATO_TAP_DEFAULT_USER_AGENT',
  'TOMATO_TAP_SAMPLES_ENABLED',
  'TOMATO_TAP_SAMPLES_RETENTION',
  'TOMATO_TAP_SAMPLES_MAX_SIZE',
  'TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL',
  'TOMATO_TAP_USAGE_RETENTION',
  'TOMATO_TAP_USAGE_LOG_MAX_SIZE',
  'TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE',
]);

export function normalizeProviderInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('provider payload must be an object');
  }
  const id = normalizeSlug(input.id);
  const label = normalizeText(input.label || id, 'provider label', 128);
  let url;
  try {
    url = new URL(String(input.baseUrl || '').trim());
  } catch {
    throw new Error('base URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('base URL must use http(s) and must not contain credentials');
  }
  if (url.search || url.hash) throw new Error('base URL must not contain a query or fragment');
  const models = uniqueNames(input.models || []);
  if (models.length === 0) throw new Error('provider requires at least one model');
  if (models.length > 200) throw new Error('provider model list is too large');
  const apiFormat = input.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const auth = input.auth === 'x-api-key' ? 'x-api-key' : 'bearer';
  const cap = {
    min: boundedInteger(input.cap?.min, 'cap.min', 1, 10_000, 1),
    initial: boundedInteger(input.cap?.initial, 'cap.initial', 1, 10_000, 1),
    max: boundedInteger(input.cap?.max, 'cap.max', 1, 10_000, 4),
  };
  if (!(cap.min <= cap.initial && cap.initial <= cap.max)) {
    throw new Error('capacity must satisfy min <= initial <= max');
  }
  const apiKey = normalizeSecret(input.apiKey);
  if (apiFormat !== 'openai' && input.logicalModel) {
    throw new Error('Anthropic-only upstreams cannot join OpenAI logical model pools');
  }
  return {
    id,
    templateProviderId: input.templateProviderId
      ? normalizeSlug(input.templateProviderId)
      : '',
    label,
    url,
    port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443,
    models,
    apiFormat,
    auth,
    enabled: input.enabled !== false,
    apiKey,
    clearCredential: input.clearCredential === true,
    userAgent: input.userAgent ? normalizeText(input.userAgent, 'User-Agent', 512) : '',
    cap,
    requestsPerMinute: optionalBoundedInteger(
      input.requestsPerMinute,
      'requestsPerMinute',
      1,
      10_000_000,
    ),
    rateLimitMode: input.rateLimitMode === 'fixed-window' ? 'fixed-window' : 'paced',
    proxy: normalizeProxyInput(input.proxy),
    fixedProxyUrl: input.fixedProxyUrl
      ? normalizeHttpUrl(input.fixedProxyUrl, 'fixed proxy URL', { allowPath: false }).toString()
      : '',
    qualityTier: normalizeText(input.qualityTier || 'standard', 'quality tier', 64),
    capabilities: normalizeCapabilities(input.capabilities || ['instruction_following']),
    thinkingAdapter: normalizeThinkingAdapter(input.thinkingAdapter),
    modelMaxInflight: boundedInteger(input.modelMaxInflight, 'modelMaxInflight', 1, 10_000, 4),
    logicalModel: input.logicalModel
      ? normalizeModelName(input.logicalModel, 'logical model name')
      : '',
    logicalCapabilities: normalizeCapabilities(
      input.logicalCapabilities || ['instruction_following'],
    ),
    logicalMaxInflight: boundedInteger(
      input.logicalMaxInflight,
      'logicalMaxInflight',
      1,
      10_000,
      8,
    ),
  };
}

export function normalizeSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('settings must be an object');
  }
  const changes = {};
  for (const name of MANAGED_SETTING_NAMES) {
    if (!Object.hasOwn(values, name)) continue;
    changes[name] = normalizeSetting(name, values[name]);
  }
  return changes;
}

export function normalizeEgressInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('egress payload must be an object');
  }
  const changes = {};
  if (input.clearSubscriptionUrls === true) {
    changes.TOMATO_TAP_PROXY_SUBSCRIPTION_URL = null;
    changes.TOMATO_TAP_PROXY_SUBSCRIPTION_URLS = null;
  } else if (String(input.subscriptionUrls || '').trim()) {
    const urls = uniqueHttpUrls(input.subscriptionUrls, 'proxy subscription URL', 20);
    changes.TOMATO_TAP_PROXY_SUBSCRIPTION_URL = null;
    changes.TOMATO_TAP_PROXY_SUBSCRIPTION_URLS = urls.join(',');
  }
  if (input.clearStaticNodes === true) {
    changes.TOMATO_TAP_PROXY_STATIC_NODES = null;
  } else if (String(input.staticNodes || '').trim()) {
    const text = String(input.staticNodes).trim();
    if (text.length > 1024 * 1024 || /\0/.test(text)) {
      throw new Error('static proxy nodes must be no larger than 1 MiB');
    }
    // Dotenv values are one line. Encoding also keeps raw private node URIs
    // out of accidental line-oriented diagnostics.
    changes.TOMATO_TAP_PROXY_STATIC_NODES = text.includes('vless://')
      ? Buffer.from(text, 'utf8').toString('base64')
      : text.replace(/\s+/g, '');
  }
  if (input.clearSharedProxy === true) {
    changes.TOMATO_TAP_SHARED_PROXY_URL = null;
  } else if (String(input.sharedProxyUrl || '').trim()) {
    changes.TOMATO_TAP_SHARED_PROXY_URL = normalizeHttpUrl(
      input.sharedProxyUrl,
      'shared proxy URL',
      { allowPath: false },
    ).toString();
  }
  return changes;
}

export function normalizeProviderDiscoveryInput(input, fallback = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('model discovery payload must be an object');
  }
  const baseUrl = String(input.baseUrl || fallback.baseUrl || '').trim();
  const url = normalizeHttpUrl(baseUrl, 'base URL');
  const apiFormat = (input.apiFormat || fallback.apiFormat) === 'anthropic'
    ? 'anthropic'
    : 'openai';
  const auth = (input.auth || fallback.auth) === 'x-api-key' ? 'x-api-key' : 'bearer';
  return {
    baseUrl: url.toString(),
    apiFormat,
    auth,
    apiKey: normalizeSecret(input.apiKey || fallback.apiKey || ''),
  };
}

export function normalizeRealModelInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('real model payload must be an object');
  }
  return {
    name: normalizeModelName(input.name, 'real model name'),
    qualityTier: normalizeText(input.qualityTier || 'standard', 'quality tier', 64),
    capabilities: normalizeCapabilities(input.capabilities || ['instruction_following']),
    thinkingAdapter: normalizeThinkingAdapter(input.thinkingAdapter),
    maxTokensMultiplier: boundedNumber(
      input.maxTokensMultiplier,
      'maxTokensMultiplier',
      1,
      100,
      1,
    ),
    maxInflight: boundedInteger(input.maxInflight, 'maxInflight', 1, 10_000, 4),
    initialLatencyMs: boundedInteger(
      input.initialLatencyMs,
      'initialLatencyMs',
      1,
      3_600_000,
      1_500,
    ),
    firstByteTimeoutMs: boundedInteger(
      input.firstByteTimeoutMs,
      'firstByteTimeoutMs',
      1,
      3_600_000,
      120_000,
    ),
    totalTimeoutMs: boundedInteger(
      input.totalTimeoutMs,
      'totalTimeoutMs',
      1,
      7_200_000,
      600_000,
    ),
    standaloneOnly: input.standaloneOnly === true,
  };
}

export function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) {
    throw new Error('provider ID must use 1-64 lowercase letters, numbers, dot, underscore, or dash');
  }
  return slug;
}

export function normalizeModelName(value, label) {
  const name = normalizeText(value, label, 128);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${label} has invalid characters`);
  return name;
}

export function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('capabilities must be a non-empty array');
  }
  return uniqueNames(value.map((item) => normalizeText(item, 'capability', 64)));
}

export function uniqueNames(values) {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const name = normalizeModelName(raw, 'model name');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(name);
  }
  return output;
}

export function boundedInteger(value, label, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function normalizeBasePath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  return path === '/' ? '' : path;
}

function normalizeProxyInput(value) {
  if (value === 'shared') return true;
  if (value === 'direct') return false;
  if (value === 'sticky-auto') return { mode: 'sticky-auto' };
  if (value === true || value === false || value == null) return value === true;
  if (value?.mode === 'sticky-auto') return { mode: 'sticky-auto' };
  if (value?.mode === 'fixed-http') return { mode: 'fixed-http' };
  if (value?.mode === 'sticky' && typeof value.node === 'string' && value.node.trim()) {
    return { mode: 'sticky', node: value.node.trim() };
  }
  throw new Error('proxy must be direct, shared, sticky-auto, fixed-http, or a fixed sticky node');
}

function uniqueHttpUrls(value, label, maxItems) {
  const output = [];
  const seen = new Set();
  for (const raw of String(value || '').split(/[\r\n,]+/)) {
    const text = raw.trim();
    if (!text) continue;
    const url = normalizeHttpUrl(text, label);
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  if (output.length === 0) throw new Error(`${label} is required`);
  if (output.length > maxItems) throw new Error(`${label} supports at most ${maxItems} entries`);
  return output;
}

function normalizeHttpUrl(value, label, { allowPath = true } = {}) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error(`${label} must be a valid http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must use http(s) and must not contain credentials`);
  }
  if (url.hash || (!allowPath && (url.pathname !== '/' || url.search))) {
    throw new Error(`${label} contains unsupported path, query, or fragment data`);
  }
  return url;
}

function normalizeThinkingAdapter(value) {
  const normalized = String(value || 'none').trim().toLowerCase();
  const allowed = new Set([
    'none',
    'glm_disabled',
    'deepseek_disabled',
    'longcat_disabled',
    'minimax_split',
    'kimi_low',
  ]);
  if (!allowed.has(normalized)) throw new Error(`unsupported thinking adapter ${normalized}`);
  return normalized;
}

function normalizeSetting(name, value) {
  const text = String(value ?? '').trim();
  if (/\r|\n|\0/.test(text)) throw new Error(`${name} must be one line`);
  if (name === 'TOMATO_TAP_ADMIN_DETAIL_LEVEL') {
    const level = text.toLowerCase();
    if (!['safe', 'operator', 'debug'].includes(level)) {
      throw new Error(`${name} must be safe, operator, or debug`);
    }
    return level;
  }
  if (name === 'TOMATO_TAP_DEFAULT_USER_AGENT') {
    return text ? normalizeText(text, 'default User-Agent', 512) : null;
  }
  if (name === 'TOMATO_TAP_SAMPLES_ENABLED' || name === 'TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS') {
    if (!['true', 'false'].includes(text.toLowerCase())) {
      throw new Error(`${name} must be true or false`);
    }
    return text.toLowerCase();
  }
  if (!/^\d+(?:\.\d+)?(?:ms|s|m|h|d|kib|mib|gib|kb|mb|gb)$/i.test(text)) {
    throw new Error(`${name} must be a duration or size such as 24h or 512MiB`);
  }
  return text;
}

function normalizeText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\0]/.test(text)) {
    throw new Error(`${label} must be 1-${maxLength} printable characters`);
  }
  return text;
}

function normalizeSecret(value) {
  if (value == null || value === '') return '';
  const secret = String(value);
  if (secret.length > 16_384 || /[\r\n\0]/.test(secret)) {
    throw new Error('API key must be one line and no longer than 16384 characters');
  }
  return secret;
}

function optionalBoundedInteger(value, label, min, max) {
  if (value == null || value === '') return null;
  return boundedInteger(value, label, min, max, null);
}

function boundedNumber(value, label, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return parsed;
}

export { DEFAULT_REAL_MODEL, MANAGED_SETTING_NAMES as OPERATOR_MANAGED_SETTINGS };
