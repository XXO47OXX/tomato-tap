// Application composition root for the tomato-tap gateway.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  quotaInferCounts,
  quotaInferEvents,
} from '../providers/quota/quota_infer.mjs';
import { buildKeyPool } from '../providers/key-discovery.mjs';
import { resolveLogicalRequest, realModelPolicy } from '../routing/model-policy.mjs';
import { createLogicalScheduler } from '../routing/logical-scheduler.mjs';
import {
  createCandidateQualificationRegistry,
} from '../routing/candidate-eligibility.mjs';
import {
  activeCooldownReason,
  applyCooldownRecords,
  exportCooldownRecords,
} from '../state/key-cooldown.mjs';
import {
  applyKeyOutcome,
  createInitialKeyState,
  pushCapHistory,
} from '../state/key-state.mjs';
import { consumeRateLimit, rateLimitStatus } from '../state/key-rate-limit.mjs';
import { createBindingStore } from '../egress/proxy-bindings.mjs';
import { createSingBoxManager } from '../egress/sing-box-manager.mjs';
import { applyProxyCooldown, initializeStickyProxyRuntime } from '../egress/sticky-proxy-runtime.mjs';
import { createQuotaWindowManager } from '../providers/quota/quota-window.mjs';
import { loadQuotaState, saveQuotaState } from '../providers/quota/quota-state-store.mjs';
import { createQuotaControlServer } from '../providers/quota/quota-control.mjs';
import {
  createRuntimeConfigLoader,
  createRuntimeConfigWatcher,
  parseDotenv,
} from '../config/runtime-config.mjs';
import { normalizeConfigBackend } from '../config/config-backend.mjs';
import { createRuntimeGenerationManager } from '../config/runtime-generation.mjs';
import { createVendorFunctionRegistry } from '../providers/protocol-registry.mjs';
import { createUpstreamHeaderPolicy } from '../providers/upstream-headers.mjs';
import { createUsageDashboard } from '../usage/usage-dashboard.mjs';
import { createUsageHistory } from '../usage/usage-history.mjs';
import { MODEL_PRICING, isWeekendAtUtcOffset } from '../usage/model-pricing.mjs';
import { createBudgetManager } from '../usage/budget-manager.mjs';
import { createRequestAccounting } from '../usage/request-accounting.mjs';
import { createUpstreamHttpTransport } from '../egress/upstream-http.mjs';
import {
  extractRequestModel,
  extractUsage,
  safeJsonParse,
  validateLogicalClientRequest,
} from '../gateway/request-body.mjs';
import { createOrdinaryDispatcher } from '../routing/ordinary-dispatch.mjs';
import { ordinaryCandidateAdmitted } from '../routing/ordinary-fallback-policy.mjs';
import { createLogicalDeploymentRegistry } from '../routing/logical-deployments.mjs';
import { createTimeRouteScheduler } from '../routing/time-route-scheduler.mjs';
import {
  createLogicalDispatcher,
  gatewayHeader,
  rejectLogical,
} from '../routing/logical-dispatch.mjs';
import { createControlPlaneHandler } from '../gateway/control-plane.mjs';
import { buildKeyPoolStatus, providerLabelForKey } from '../gateway/key-pool-status.mjs';
import { createModelInventory } from '../gateway/model-inventory.mjs';
import { createGatewayRequestHandler } from '../gateway/gateway-request-handler.mjs';
import { createSampleLogger } from '../telemetry/sample-logger.mjs';
import { gatewayLimitsFromEnv } from '../gateway/gateway-policy.mjs';
import { parseBoolean, parseDuration } from '../config/config-values.mjs';
import { createUsageLedger, listUsageLogFiles } from '../usage/usage-ledger.mjs';
import { resolveStateLayout } from '../config/state-layout.mjs';
import { applyLegacyEnvAliases } from '../config/env-compat.mjs';
import {
  createOperatorConfigStore,
  ensureOperatorConfigFiles,
} from '../admin/operator-config-store.mjs';
import { createAdminConsole } from '../admin/admin-console.mjs';
import { createCursorAcpBridge } from '../providers/adapters/cursor-acp-bridge.mjs';
import { appendCursorAcpDeployment } from '../providers/adapters/cursor-acp-deployment.mjs';

process.umask(0o077);

// ---- Load .env (so nohup-spawned process sees keys without inheriting shell env) ----
// Order: $TOMATO_TAP_ENV_FILE → project .env → no-op.
// Variables already set in process.env are NOT overridden.
function loadDotenv(path) {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) {
      process.env[k] = v;
      n++;
    }
  }
  return n;
}
applyLegacyEnvAliases(process.env, { warn: true });
// Only variables inherited from the parent process are authoritative. Values
// loaded from the env file remain reloadable, including rotations of an
// existing credential.
const PROCESS_ENV_OVERRIDES = Object.freeze({ ...process.env });
const sourceDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDir, '../..');
const projectEnvPath = join(projectRoot, '.env');
const _envPath = process.env.TOMATO_TAP_ENV_FILE || projectEnvPath;
const _envLoaded = loadDotenv(_envPath);
applyLegacyEnvAliases(process.env, { warn: true });
if (_envLoaded > 0) console.log(`[tomato-tap] loaded ${_envLoaded} env vars from ${_envPath}`);

const PORT = Number(process.env.PORT || 8888);
const BIND_HOST = process.env.TOMATO_TAP_BIND_HOST || '127.0.0.1';
const GATEWAY_LIMITS = gatewayLimitsFromEnv(process.env);
const LOG_KEY_INVENTORY = parseBoolean(
  process.env.TOMATO_TAP_LOG_KEY_INVENTORY,
  'TOMATO_TAP_LOG_KEY_INVENTORY',
);
const EXPOSE_UPSTREAM_HOSTS = parseBoolean(
  process.env.TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS,
  'TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS',
);
const ADMIN_DETAIL_LEVEL = process.env.TOMATO_TAP_ADMIN_DETAIL_LEVEL || 'safe';
const STATE_LAYOUT = resolveStateLayout(projectRoot, process.env);
const STATE_DIR = STATE_LAYOUT.stateDir;
const RUNTIME_STATE_DIR = STATE_LAYOUT.runtimeDir;
const SAMPLES = join(STATE_DIR, 'samples');
const BUDGET_FILE = join(STATE_DIR, 'budget.json');
const USAGE_LOG = join(STATE_DIR, 'usage.log');
const SAMPLE_LOGGER = createSampleLogger({
  directory: SAMPLES,
  env: process.env,
});

const OPERATOR_CONFIG_DIR = process.env.TOMATO_TAP_CONFIG_DIR
  || join(projectRoot, 'config', 'local');
const OPERATOR_CONFIG_PATHS = ensureOperatorConfigFiles({
  relaysPath: process.env.TOMATO_TAP_RELAYS_PATH || join(OPERATOR_CONFIG_DIR, 'relays.json'),
  modelsPath: process.env.TOMATO_TAP_MODELS_PATH || join(OPERATOR_CONFIG_DIR, 'models.json'),
  seedRelaysPath: join(projectRoot, 'config', 'relays.json'),
  seedModelsPath: join(projectRoot, 'config', 'models.json'),
});
const CONFIG_BACKEND_REQUESTED = normalizeConfigBackend(process.env.TOMATO_TAP_CONFIG_BACKEND);
const CONFIG_REGISTRY_PATH = process.env.TOMATO_TAP_CONFIG_DB_PATH
  || join(RUNTIME_STATE_DIR, 'tomato-config.db');
let SQLITE_CONFIG_STORE = null;
let SQLITE_OPERATOR_REPOSITORY = null;
if (CONFIG_BACKEND_REQUESTED !== 'files') {
  try {
    const {
      createSqliteConfigStore,
      createSqliteOperatorRepository,
    } = await import('../config/sqlite-config-store.mjs');
    const candidate = createSqliteConfigStore({ path: CONFIG_REGISTRY_PATH });
    if (CONFIG_BACKEND_REQUESTED === 'sqlite' && !candidate.snapshot()) {
      candidate.replaceAll({
        env: parseDotenv(existsSync(_envPath) ? readFileSync(_envPath, 'utf8') : ''),
        relays: JSON.parse(readFileSync(OPERATOR_CONFIG_PATHS.relaysPath, 'utf8')),
        models: JSON.parse(readFileSync(OPERATOR_CONFIG_PATHS.modelsPath, 'utf8')),
      });
      console.log(`[tomato-tap] initialized SQLite configuration at ${CONFIG_REGISTRY_PATH}`);
    }
    if (candidate.snapshot()) {
      SQLITE_CONFIG_STORE = candidate;
      SQLITE_OPERATOR_REPOSITORY = createSqliteOperatorRepository(candidate);
    } else {
      candidate.close();
    }
  } catch (error) {
    const unsupported = error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(String(error?.message || ''));
    if (CONFIG_BACKEND_REQUESTED === 'auto' && unsupported) {
      console.warn('[tomato-tap] SQLite configuration requires Node.js 22.5+; using files');
    } else {
      throw error;
    }
  }
}
const OPERATOR_CONFIG_STORE = createOperatorConfigStore({
  envPath: _envPath,
  relaysPath: OPERATOR_CONFIG_PATHS.relaysPath,
  modelsPath: OPERATOR_CONFIG_PATHS.modelsPath,
  processEnvOverrides: PROCESS_ENV_OVERRIDES,
  repository: SQLITE_OPERATOR_REPOSITORY,
});

// ---- Budget and vendor accounting ----
const BUDGET_MANAGER = createBudgetManager({
  path: BUDGET_FILE,
  env: process.env,
  parseRequest: safeJsonParse,
  isWeekendAtUtcOffset,
  onDailyReset: () => {
    retryStats = freshRetryStats();
    resetKeyDailyStats();
  },
});
const {
  budget,
  vendorSpendToday,
  modelMultiplier,
  saveBudget,
  inWindow,
  resetDailyVendorSpend,
  checkVendorConstraints,
  recordVendorSpend,
  recordVendorCnySpend,
  reserveVendorCny,
  releaseVendorCny,
  estimateVendorCny,
  extractRequestedModel,
  estimateRequestReserveCny,
  checkVendorCnyReservation,
  checkVendorPricingCoverage,
  isVendorPeakPeriod,
  settings: BUDGET_SETTINGS,
} = BUDGET_MANAGER;
const WINDOW_START_UTC_HOUR = BUDGET_SETTINGS.windowStartUtcHour;
const WINDOW_END_UTC_HOUR = BUDGET_SETTINGS.windowEndUtcHour;
const OFFPEAK_MULT = BUDGET_SETTINGS.offPeakMultiplier;

// ---- Header rewriting ----
const REDACT_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);
function maskHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase())
      ? '[redacted]'
      : v;
  }
  return out;
}

// ---- Key pool (per-key concurrency control) ----
// Credentials matching a vendor's discovery rule join that vendor's pool.
// Each key gets its own AIMD-adapted concurrency cap. Selection is
// shortest-queue-first with a round-robin tiebreak.
// When every key is saturated or cooling down, callers receive a bounded 503.
//
// Cooldowns on failure:
//   401 (Invalid API Key) → 24h cooldown by default, configurable per vendor.
//   429 (Rate limited)    → 30s default, or the upstream `Retry-After` value.
//
// Per-key host metadata prevents region-bound credentials from being sent to
// the wrong endpoint.
//
// ---- Multi-vendor pool ----
// Each vendor defines: env-var prefix, accepted client URL prefixes (path-based
// routing), optional path rewrite (client URL → upstream URL), default upstream
// host, and auth-header injector. The pool concept (AIMD / 5xx penalty / retry /
// shortest-queue) is upstream-agnostic; only auth + host differ.
// Vendor entries support multiple client routes without duplicating a
// credential or its concurrency/cooldown state. The registry is loaded from
// vendors.json; provider behavior does not belong in this composition root.
//
const VENDOR_FUNCTION_REGISTRY = createVendorFunctionRegistry();
const RUNTIME_CONFIG_LOADER = createRuntimeConfigLoader({
  functionRegistry: VENDOR_FUNCTION_REGISTRY,
  processEnvOverrides: PROCESS_ENV_OVERRIDES,
  envFile: _envPath,
  vendorsPath: process.env.TOMATO_TAP_VENDORS_PATH || join(projectRoot, 'config', 'vendors.json'),
  relaysPath: OPERATOR_CONFIG_PATHS.relaysPath,
  modelsPath: OPERATOR_CONFIG_PATHS.modelsPath,
  registryPath: CONFIG_REGISTRY_PATH,
  sqliteSnapshotLoader: SQLITE_CONFIG_STORE
    ? () => SQLITE_CONFIG_STORE.snapshot()
    : null,
});
let RUNTIME_CONFIG = RUNTIME_CONFIG_LOADER.load();
let VENDORS = RUNTIME_CONFIG.VENDORS;
let VENDOR_CAP_OVERRIDES = RUNTIME_CONFIG.VENDOR_CAP_OVERRIDES;
let MODEL_POLICY = RUNTIME_CONFIG.modelPolicy;
let RUNTIME_ENV = RUNTIME_CONFIG.env;
let TIME_ROUTE_SCHEDULER = createTimeRouteScheduler(RUNTIME_CONFIG.timeRoutePolicy);
const LOGICAL_SCHEDULER = createLogicalScheduler();
const CANDIDATE_QUALIFICATION_PATH = process.env.TOMATO_TAP_QUALIFICATION_STATE_PATH
  || join(RUNTIME_STATE_DIR, 'candidate-qualifications.json');
const CANDIDATE_QUALIFICATION_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.TOMATO_TAP_QUALIFICATION_MAX_AGE_MS) || 6 * 60 * 60 * 1000,
);
const CANDIDATE_QUALIFICATIONS = createCandidateQualificationRegistry({
  failureBackoffBaseMs: parseDuration(
    process.env.TOMATO_TAP_QUALIFICATION_BACKOFF_BASE || '30s',
    'TOMATO_TAP_QUALIFICATION_BACKOFF_BASE',
    { minMs: 1_000 },
  ),
  failureBackoffMaxMs: parseDuration(
    process.env.TOMATO_TAP_QUALIFICATION_BACKOFF_MAX || '15m',
    'TOMATO_TAP_QUALIFICATION_BACKOFF_MAX',
    { minMs: 1_000 },
  ),
});
let candidateQualificationPersistTimer = null;
try {
  if (existsSync(CANDIDATE_QUALIFICATION_PATH)) {
    const persisted = JSON.parse(readFileSync(CANDIDATE_QUALIFICATION_PATH, 'utf8'));
    const restored = CANDIDATE_QUALIFICATIONS.hydrate(persisted.records, {
      maxAgeMs: CANDIDATE_QUALIFICATION_MAX_AGE_MS,
    });
    console.log(`[candidate-eligibility] restored recent qualifications=${restored}`);
  }
} catch (error) {
  console.warn(`[candidate-eligibility] ignored unreadable state: ${String(error?.message || error).slice(0, 256)}`);
}
const MODEL_INFLIGHT = new Map();

const CURSOR_ACP_SETTINGS = Object.freeze({
  enabled: parseBoolean(
    process.env.TOMATO_TAP_CURSOR_ACP_ENABLED,
    'TOMATO_TAP_CURSOR_ACP_ENABLED',
    { defaultValue: false },
  ),
  host: process.env.TOMATO_TAP_CURSOR_ACP_BIND_HOST || '127.0.0.1',
  port: positiveInteger(process.env.TOMATO_TAP_CURSOR_ACP_PORT, 8891),
  command: process.env.TOMATO_TAP_CURSOR_ACP_COMMAND || 'cursor-agent',
  apiKey: process.env.TOMATO_TAP_CURSOR_ACP_API_KEY
    || decodeOptionalBase64(process.env.TOMATO_TAP_CURSOR_ACP_API_KEY_B64),
  cwd: process.env.TOMATO_TAP_CURSOR_ACP_CWD || projectRoot,
  model: process.env.TOMATO_TAP_CURSOR_ACP_MODEL || '',
  maxConcurrent: positiveInteger(process.env.TOMATO_TAP_CURSOR_ACP_MAX_CONCURRENT, 1),
  timeoutMs: parseDuration(
    process.env.TOMATO_TAP_CURSOR_ACP_TIMEOUT || '10m',
    'TOMATO_TAP_CURSOR_ACP_TIMEOUT',
    { minMs: 1_000 },
  ),
});
const CURSOR_ACP_BRIDGE = createCursorAcpBridge({ ...CURSOR_ACP_SETTINGS, logger: console });
if (CURSOR_ACP_BRIDGE.enabled) await CURSOR_ACP_BRIDGE.listen();

function buildRuntimeKeyPool(config) {
  return appendCursorAcpDeployment(buildKeyPool(config), CURSOR_ACP_SETTINGS);
}

let KEY_POOL = buildRuntimeKeyPool(RUNTIME_CONFIG);

const QUOTA_STATE_PATH = process.env.TOMATO_TAP_QUOTA_STATE_PATH
  || join(RUNTIME_STATE_DIR, 'quota-windows.json');
const QUOTA_SOCKET_PATH = process.env.TOMATO_TAP_QUOTA_SOCKET_PATH
  || join(RUNTIME_STATE_DIR, 'quota-control.sock');
const KEY_COOLDOWN_PATH = process.env.TOMATO_TAP_KEY_COOLDOWN_PATH
  || join(RUNTIME_STATE_DIR, 'key-cooldowns.json');
let QUOTA_MANAGER = createQuotaWindowManager({
  deployments: KEY_POOL,
  persisted: loadQuotaState(QUOTA_STATE_PATH),
  now: Date.now(),
});
let QUOTA_MANAGED_DEPLOYMENTS = new Set(
  KEY_POOL
    .filter((deployment) => deployment.quotaPolicy)
    .map((deployment) => deployment.deploymentId),
);
const QUOTA_PERSIST_RETRY_MS = Math.max(
  25,
  Number(process.env.TOMATO_TAP_QUOTA_PERSIST_RETRY_MS) || 5_000,
);
let QUOTA_PERSISTENCE_HEALTHY = true;

function persistQuotaState() {
  try {
    saveQuotaState(QUOTA_STATE_PATH, QUOTA_MANAGER.snapshot(), Date.now());
    QUOTA_PERSISTENCE_HEALTHY = true;
    return true;
  } catch (error) {
    QUOTA_PERSISTENCE_HEALTHY = false;
    console.error(`[quota-state] persist failed: ${error.message}`);
    return false;
  }
}

function quotaCanDispatch(deploymentId, now = Date.now()) {
  if (!QUOTA_MANAGED_DEPLOYMENTS.has(deploymentId)) return true;
  return QUOTA_PERSISTENCE_HEALTHY && QUOTA_MANAGER.canDispatch(deploymentId, now);
}

function recordQuotaRequestResult(keyPick, result, quotaSignal) {
  const changed = QUOTA_MANAGER.recordRequestResult({
    deploymentId: keyPick.deploymentId,
    status: result.status,
    quotaSignal,
    observedAt: Date.now(),
  });
  if (changed) persistQuotaState();
  return quotaSignal;
}

mkdirSync(dirname(QUOTA_SOCKET_PATH), { recursive: true, mode: 0o700 });
persistQuotaState();
setInterval(() => {
  if (!QUOTA_PERSISTENCE_HEALTHY) persistQuotaState();
}, QUOTA_PERSIST_RETRY_MS).unref();
const QUOTA_MANAGER_FACADE = {
  claimDueProbes: (...args) => QUOTA_MANAGER.claimDueProbes(...args),
  recordProbeResult: (...args) => QUOTA_MANAGER.recordProbeResult(...args),
  recordRequestResult: (...args) => QUOTA_MANAGER.recordRequestResult(...args),
  canDispatch: (...args) => QUOTA_MANAGER.canDispatch(...args),
  weightMultiplier: (...args) => QUOTA_MANAGER.weightMultiplier(...args),
  advance: (...args) => QUOTA_MANAGER.advance(...args),
  snapshot: (...args) => QUOTA_MANAGER.snapshot(...args),
};
const QUOTA_CONTROL_SERVER = createQuotaControlServer({
  socketPath: QUOTA_SOCKET_PATH,
  manager: QUOTA_MANAGER_FACADE,
  onStateChanged: (_snapshot, event) => {
    if (event?.method === 'report_probe' && event.accepted && event.valid) {
      reconcileQuotaOpen(event.deploymentId);
    }
    if (!persistQuotaState()) throw new Error('quota state is not durable');
  },
});

const proxyPortStart = Number(process.env.TOMATO_TAP_PROXY_PORT_START || 11001);
const proxyPortEnd = Number(process.env.TOMATO_TAP_PROXY_PORT_END || (proxyPortStart + 998));
const PROXY_BINDING_STORE = createBindingStore({
  path: process.env.TOMATO_TAP_PROXY_BINDINGS_PATH || join(RUNTIME_STATE_DIR, 'proxy-bindings.json'),
  portStart: proxyPortStart,
  portEnd: proxyPortEnd,
});
const SING_BOX_MANAGER = createSingBoxManager({
  binary: process.env.TOMATO_TAP_SING_BOX_BIN || 'sing-box',
  runtimeDir: join(RUNTIME_STATE_DIR, 'sing-box'),
});
function stickyRuntimeOptions(env = RUNTIME_ENV) {
  return {
  subscriptionUrl: [
    env.TOMATO_TAP_PROXY_SUBSCRIPTION_URL || '',
    ...(env.TOMATO_TAP_PROXY_SUBSCRIPTION_URLS || '').split(','),
  ],
  staticSubscriptionText: env.TOMATO_TAP_PROXY_STATIC_NODES || '',
  fetchText: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`proxy subscription HTTP ${response.status}`);
    return response.text();
  },
  bindingStore: PROXY_BINDING_STORE,
  manager: SING_BOX_MANAGER,
  };
}
let STICKY_PROXY_RUNTIME = await initializeStickyProxyRuntime({
  keys: KEY_POOL,
  ...stickyRuntimeOptions(RUNTIME_ENV),
});

function keyRuntimeAvailable(key, now = Date.now()) {
  if (key.expiresAtMs > 0 && now >= key.expiresAtMs) return false;
  return STICKY_PROXY_RUNTIME.isKeyAvailable(key);
}

function keyRateLimitStatus(key, state, now = Date.now()) {
  return rateLimitStatus(state, key?.rateLimitPolicy || null, now);
}

function recordStickyProxyResult(keyIndex, result) {
  const outcome = STICKY_PROXY_RUNTIME.recordResult(KEY_POOL[keyIndex], result);
  applyProxyCooldown(KEY_STATE[keyIndex], outcome);
  if (outcome.cooldownMs > 0) scheduleKeyCooldownPersist();
}

// Returns { vendor, route } where route is the matched {prefix,rewrite}, or null.
function routeForPath(url) {
  let match = null;
  let matchLen = -1;
  for (const [name, vcfg] of Object.entries(VENDORS)) {
    for (const r of vcfg.routes) {
      if (!(url === r.prefix || url.startsWith(r.prefix + '/'))) {
        continue;
      }
      if (r.prefix.length > matchLen) {
        match = { vendor: name, route: r };
        matchLen = r.prefix.length;
      }
    }
  }
  return match;
}

// ---- AIMD per-key capacity and recent-outcome telemetry ----
// Capacity grows after consecutive successes and is reduced on rate limits.
const PER_KEY_CAP_INITIAL = 12;
const PER_KEY_CAP_MIN = 1;
const PER_KEY_CAP_MAX = 32;
const CAP_GROW_AFTER_N = 4;
const CAP_HISTORY_LEN = 8;                      // length of capHistory ring

// Per-vendor cap overrides come from vendors.json `capPolicies` + per-vendor
// `capPolicyRef` / `vendorMaxInflight`. Defaults below apply when a vendor
// has no entry in VENDOR_CAP_OVERRIDES (i.e. no capPolicyRef and no inflight
// override in vendors.json):
//   initial = PER_KEY_CAP_INITIAL (12)
//   min     = PER_KEY_CAP_MIN (1)
//   max     = PER_KEY_CAP_MAX (32)
//   vendorMaxInflight = Infinity (no vendor-wide gate)
function vendorCap(vendor, field) {
  return vendorCapFrom(VENDOR_CAP_OVERRIDES, vendor, field);
}

function vendorCapFrom(overrides, vendor, field) {
  const o = overrides?.[vendor];
  if (o && o[field] != null) return o[field];
  if (field === 'initial')           return PER_KEY_CAP_INITIAL;
  if (field === 'min')               return PER_KEY_CAP_MIN;
  if (field === 'max')               return PER_KEY_CAP_MAX;
  if (field === 'vendorMaxInflight') return Infinity;
  return undefined;
}
const OUTCOMES_LEN = 32;                        // length of outcomes ring (per key)
const KEY_401_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KEY_429_COOLDOWN_DEFAULT_MS = 30 * 1000;  // 30s when upstream omits Retry-After
// Long quota windows are honored up to a bounded seven-day ceiling.
const KEY_429_COOLDOWN_MAX_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

// Per (key × model) cooldown for dead-model responses (HTTP 404 invalid_model,
// or any 4xx whose body is recognisably a "model unavailable" verdict).
// Same model on a different key may still work — so this can't piggyback on
// the per-key `badUntil` field. Default = 24h.
const DEAD_MODEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// QUOTA_BODY_PATTERNS + inferLongCooldownFromBody now live in quota_infer.mjs
// (testable + single-responsibility). See top-of-file import.
// Upstream 5xx responses reduce capacity and apply a bounded cooldown.
//   Light penalty:  one 5xx → cap halved + 60s cooldown (transient hypothesis)
//   Heavy penalty:  consec5xx >= threshold → 5min cooldown (account-side dead)
const KEY_5XX_COOLDOWN_MS = 60 * 1000;          // 60s after any 5xx
const KEY_5XX_PERSISTENT_COOLDOWN_MS = 5 * 60 * 1000;  // 5min after CONSEC_5XX_THRESHOLD
const CONSEC_5XX_THRESHOLD = 3;

// 403 is the ambiguous code: "auth ok but you're forbidden". Treated like a
// permanent-for-this-key signal (banned, IP blocked, quota tier mismatch),
// so we hold the key out for the same 1 h block as the post-5xx-streak ladder
// uses. A single 403 isn't yet conclusive — wait for a few before reacting.
const KEY_403_COOLDOWN_MS = 60 * 60 * 1000;     // 1h
const RELAY_MODEL_403_COOLDOWN_MS = 30 * 60 * 1000;
const CONSEC_403_THRESHOLD = 3;

// A mixed-error streak protects an unhealthy upstream from continued traffic.
const CONSEC_ERR_THRESHOLD = 8;
const KEY_BURST_ERR_COOLDOWN_MS = 60 * 60 * 1000;  // 1h

function createKeyState(k, capOverrides = VENDOR_CAP_OVERRIDES) {
  // Per-key cap override (relay vendor sibling vars) takes precedence over
  // the vendor-level cap policy.
  const initial = (k.capInitial != null)
    ? k.capInitial
    : vendorCapFrom(capOverrides, k.vendor, 'initial');
  return createInitialKeyState(initial);
}
let KEY_STATE = KEY_POOL.map((key) => createKeyState(key));
let keyCursor = 0;

let USAGE_PROVIDER_BY_KEY = new Map();
let USAGE_PROVIDER_BY_DEPLOYMENT = new Map();

function usageProviderName(key) {
  return providerLabelForKey(key);
}

function rebuildUsageProviderIndexes() {
  USAGE_PROVIDER_BY_KEY = new Map();
  USAGE_PROVIDER_BY_DEPLOYMENT = new Map();
  for (const key of KEY_POOL) {
    const provider = usageProviderName(key);
    if (key.name) USAGE_PROVIDER_BY_KEY.set(key.name, provider);
    if (key.deploymentId) USAGE_PROVIDER_BY_DEPLOYMENT.set(key.deploymentId, provider);
  }
}

rebuildUsageProviderIndexes();

function runtimeKeyIdentity(key) {
  return [
    key.vendor,
    key.deploymentId,
    key.value,
    key.host,
    key.pathPrefix,
    key.proto,
    key.port,
    key.proxyUrl,
    key.proxyMode,
    [...(key.apiFormats || [])].sort().join(','),
    key.authType || '',
    JSON.stringify(key.requestPolicy || null),
    JSON.stringify(key.rateLimitPolicy || null),
    key.fallbackAdmission || 'always',
    key.quotaSignalProfile || '',
    JSON.stringify(key.quotaPolicy || null),
    [...(key.canonicalModelSet || [])].map(String).sort().join(','),
    [...(key.upstreamModelSet || [])].map(String).sort().join(','),
    JSON.stringify([...(key.modelAliases || [])].sort()),
  ].join('\u0000');
}

function runtimeKeyFingerprint(key) {
  return createHash('sha256').update(runtimeKeyIdentity(key)).digest('hex').slice(0, 24);
}

function persistCandidateQualifications() {
  if (candidateQualificationPersistTimer) {
    clearTimeout(candidateQualificationPersistTimer);
    candidateQualificationPersistTimer = null;
  }
  try {
    mkdirSync(dirname(CANDIDATE_QUALIFICATION_PATH), { recursive: true, mode: 0o700 });
    const temporary = `${CANDIDATE_QUALIFICATION_PATH}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: 1,
      savedAt: Date.now(),
      records: CANDIDATE_QUALIFICATIONS.exportState(),
    }), { mode: 0o600 });
    renameSync(temporary, CANDIDATE_QUALIFICATION_PATH);
    return true;
  } catch (error) {
    console.error(`[candidate-eligibility] persist failed: ${String(error?.message || error).slice(0, 256)}`);
    return false;
  }
}

function scheduleCandidateQualificationPersist() {
  if (candidateQualificationPersistTimer) return;
  candidateQualificationPersistTimer = setTimeout(persistCandidateQualifications, 500);
  candidateQualificationPersistTimer.unref?.();
}

// Persist key cooldowns across restarts by runtime fingerprint.
function persistKeyCooldowns() {
  if (keyCooldownPersistTimer) {
    clearTimeout(keyCooldownPersistTimer);
    keyCooldownPersistTimer = null;
  }
  try {
    mkdirSync(dirname(KEY_COOLDOWN_PATH), { recursive: true, mode: 0o700 });
    const temporary = `${KEY_COOLDOWN_PATH}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: 1,
      savedAt: Date.now(),
      records: exportCooldownRecords(KEY_STATE, (i) => runtimeKeyFingerprint(KEY_POOL[i])),
    }), { mode: 0o600 });
    renameSync(temporary, KEY_COOLDOWN_PATH);
    KEY_COOLDOWN_PERSISTENCE_HEALTHY = true;
    return true;
  } catch (error) {
    KEY_COOLDOWN_PERSISTENCE_HEALTHY = false;
    console.error(`[cooldown-persist] persist failed: ${String(error?.message || error).slice(0, 256)}`);
    return false;
  }
}

function scheduleKeyCooldownPersist() {
  if (keyCooldownPersistTimer) return;
  keyCooldownPersistTimer = setTimeout(persistKeyCooldowns, 1_000);
  keyCooldownPersistTimer.unref?.();
}

function restoreKeyCooldowns() {
  let records;
  try {
    records = JSON.parse(readFileSync(KEY_COOLDOWN_PATH, 'utf8'))?.records;
  } catch {
    return 0; // missing or corrupt file: start clean
  }
  return applyCooldownRecords(records, KEY_STATE, (i) => runtimeKeyFingerprint(KEY_POOL[i]));
}

let keyCooldownPersistTimer = null;
let KEY_COOLDOWN_PERSISTENCE_HEALTHY = true;
const RESTORED_KEY_COOLDOWNS = restoreKeyCooldowns();
if (RESTORED_KEY_COOLDOWNS > 0) {
  console.log(`[cooldown-persist] restored ${RESTORED_KEY_COOLDOWNS} cooldowns from ${KEY_COOLDOWN_PATH}`);
}

function recordCandidateQualification(key, model, validation, result) {
  const configuredKey = Number.isInteger(key.idx) ? (KEY_POOL[key.idx] || key) : key;
  CANDIDATE_QUALIFICATIONS.record({
    deploymentId: key.deploymentId,
    model,
    valid: validation.valid,
    failureClass: validation.failureClass,
    latencyMs: result.elapsedMs || 0,
    firstByteMs: result.firstByteMs || 0,
    identity: runtimeKeyFingerprint(configuredKey),
  });
  scheduleCandidateQualificationPersist();
}

function runtimeIdle() {
  if (KEY_STATE.some((state) => state.inflight > 0)) return false;
  const activeLogical = LOGICAL_SCHEDULER.snapshot(Date.now()).activeByLogical;
  return Object.keys(activeLogical).length === 0;
}

function qualificationPairsForKeys(keys, vendors, modelPolicy) {
  const pairs = [];
  for (const key of keys) {
    const models = key.modelSet instanceof Set
      ? key.modelSet
      : (key.nativeModels || vendors[key.vendor]?.nativeModels || []);
    for (const model of models) {
      const policy = realModelPolicy(modelPolicy, model);
      if (!policy) continue;
      pairs.push({
        deploymentId: key.deploymentId,
        model: policy.name,
        identity: runtimeKeyFingerprint(key),
      });
    }
  }
  return pairs;
}

if (CANDIDATE_QUALIFICATIONS.reconcile(
  qualificationPairsForKeys(KEY_POOL, VENDORS, MODEL_POLICY),
)) {
  scheduleCandidateQualificationPersist();
}

// Config generations own their timers; the sing-box manager is shared.
let PENDING_STICKY_RUNTIME = null;

async function prepareRuntimeConfig(candidate) {
  const keyPool = buildRuntimeKeyPool(candidate);
  const stickyRuntime = await initializeStickyProxyRuntime({
    keys: keyPool,
    ...stickyRuntimeOptions(candidate.env),
  });
  if (PENDING_STICKY_RUNTIME && PENDING_STICKY_RUNTIME !== stickyRuntime) {
    PENDING_STICKY_RUNTIME.dispose?.();
  }
  PENDING_STICKY_RUNTIME = stickyRuntime;
  return { keyPool, stickyRuntime };
}

function activateRuntimeConfig(candidate, { keyPool, stickyRuntime }) {
  const previousStates = new Map(
    KEY_POOL.map((key, index) => [runtimeKeyIdentity(key), KEY_STATE[index]]),
  );
  const keyState = keyPool.map((key) => {
    const preserved = previousStates.get(runtimeKeyIdentity(key));
    if (!preserved) return createKeyState(key, candidate.VENDOR_CAP_OVERRIDES);
    const min = key.capMin != null
      ? key.capMin
      : vendorCapFrom(candidate.VENDOR_CAP_OVERRIDES, key.vendor, 'min');
    const max = key.capMax != null
      ? key.capMax
      : vendorCapFrom(candidate.VENDOR_CAP_OVERRIDES, key.vendor, 'max');
    preserved.cap = Math.max(min, Math.min(max, preserved.cap));
    return preserved;
  });
  const quotaManager = createQuotaWindowManager({
    deployments: keyPool,
    persisted: { corrupt: false, windows: QUOTA_MANAGER.snapshot() },
    now: Date.now(),
  });
  const stableKeys = keyPool.filter((key) => previousStates.has(runtimeKeyIdentity(key)));
  const qualificationChanged = CANDIDATE_QUALIFICATIONS.reconcile(
    qualificationPairsForKeys(stableKeys, candidate.VENDORS, candidate.modelPolicy),
  );
  if (qualificationChanged) scheduleCandidateQualificationPersist();

  RUNTIME_CONFIG = candidate;
  VENDORS = candidate.VENDORS;
  VENDOR_CAP_OVERRIDES = candidate.VENDOR_CAP_OVERRIDES;
  MODEL_POLICY = candidate.modelPolicy;
  TIME_ROUTE_SCHEDULER = createTimeRouteScheduler(candidate.timeRoutePolicy);
  RUNTIME_ENV = candidate.env;
  KEY_POOL = keyPool;
  KEY_STATE = keyState;
  rebuildUsageProviderIndexes();
  keyCursor = KEY_POOL.length > 0 ? keyCursor % KEY_POOL.length : 0;
  QUOTA_MANAGER = quotaManager;
  QUOTA_MANAGED_DEPLOYMENTS = new Set(
    KEY_POOL.filter((deployment) => deployment.quotaPolicy).map((deployment) => deployment.deploymentId),
  );
  const previousRuntime = STICKY_PROXY_RUNTIME;
  STICKY_PROXY_RUNTIME = stickyRuntime;
  PENDING_STICKY_RUNTIME = null;
  if (previousRuntime && previousRuntime !== stickyRuntime) {
    previousRuntime.dispose?.(); // timers only — sing-box listeners are shared
  }
  persistQuotaState();
  console.log(`[config-reload] key pool activated keys=${KEY_POOL.length}`);
}

const RUNTIME_GENERATION = createRuntimeGenerationManager({
  initialRevision: RUNTIME_CONFIG.revision,
  initialAppliedAt: RUNTIME_CONFIG.loadedAt,
  prepare: prepareRuntimeConfig,
  activate: activateRuntimeConfig,
  isIdle: runtimeIdle,
});

const RUNTIME_CONFIG_WATCHER = createRuntimeConfigWatcher({
  loader: RUNTIME_CONFIG_LOADER,
  initialRevision: RUNTIME_CONFIG.revision,
  intervalMs: Number(process.env.TOMATO_TAP_CONFIG_RELOAD_MS || 2_000),
  onCandidate: RUNTIME_GENERATION.stage,
  onError: (error) => {
    RUNTIME_GENERATION.recordError(error);
    console.error(`[config-reload] rejected candidate: ${error}`);
  },
});
setInterval(() => RUNTIME_GENERATION.tryActivate(), 100).unref();

function reconcileQuotaOpen(deploymentId) {
  const index = KEY_POOL.findIndex((key) => key.deploymentId === deploymentId);
  if (index < 0) return;
  const key = KEY_POOL[index];
  const state = KEY_STATE[index];
  const initial = key.capInitial != null ? key.capInitial : vendorCap(key.vendor, 'initial');
  if (state.cap !== initial) {
    state.cap = initial;
    pushCapHistory(state);
  }
  if (['quota_429', 'forbidden_403', 'mixed_error'].includes(state.cooldownReason)) {
    state.badUntil = 0;
    state.cooldownReason = null;
  }
  state.consec2xx = 0;
  state.consec5xx = 0;
  state.consec403 = 0;
  state.consecErr = 0;
}

await QUOTA_CONTROL_SERVER.listen();

// Parse Retry-After as either delta seconds or an HTTP date.
function parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  // Form 1: integer seconds
  if (/^\d+(\.\d+)?$/.test(v)) {
    const sec = Number(v);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  // Form 2: HTTP-date
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const diff = t - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

// Shortest-queue-first key selection with a round-robin tiebreak.
// On ties (multiple keys with same `cap - inflight`), the RR-from-cursor
// probe order picks the first one encountered → keyCursor advances on every
// acquire, so subsequent dispatches will prefer a different tied key.
// `vendor` (optional) filters the candidate pool to keys of that vendor —
// required for safe multi-vendor co-residency.
// Returns { idx, name, value, host, vendor } on success, null otherwise.
function pickKeyAndAcquire(excluded, vendor, requestedModel, format) {
  const now = Date.now();
  const N = KEY_POOL.length;
  if (N === 0) return null;
  const governedPolicy = realModelPolicy(MODEL_POLICY, requestedModel);
  if (governedPolicy
      && !vendorUnboundedModelConcurrency(vendor)
      && (MODEL_INFLIGHT.get(governedPolicy.name.toLowerCase()) || 0) >= governedPolicy.maxInflight) {
    return null;
  }
  const exc = excluded || new Set();

  // A vendor-wide gate handles credentials that share an upstream account or
  // aggregate rate ceiling. Per-key capacity cannot bypass that ceiling.
  if (vendor) {
    const wideCap = vendorCap(vendor, 'vendorMaxInflight');
    if (wideCap !== Infinity) {
      let inflightSum = 0;
      for (let i = 0; i < N; i++) {
        if (KEY_POOL[i].vendor === vendor) inflightSum += KEY_STATE[i].inflight;
      }
      if (inflightSum >= wideCap) return null;
    }
  }

  // Prefer strict round-robin while keys have spare capacity, then fall back
  // to shortest-queue-first. Model allowlists remain scoped to each key.
  const RR_THRESHOLD = 2;
  const preferHigherWeight = VENDORS[vendor]?.preferHigherWeight === true;
  let bestIdx = -1;
  let bestAvailable = -1;
  let bestWeight = -Infinity;
  let rrIdx = -1;
  for (let probe = 0; probe < N; probe++) {
    const idx = (keyCursor + probe) % N;
    if (exc.has(idx)) continue;
    const k = KEY_POOL[idx];
    if (vendor && k.vendor !== vendor) continue;
    if (format && k.apiFormats instanceof Set && !k.apiFormats.has(format)) continue;
    if (requestedModel && k.modelSet && !k.modelSet.has(requestedModel)) continue;
    if (!ordinaryKeyAdmissionAllowed(k, vendor, requestedModel, format, now)) continue;
    if (!keyRuntimeAvailable(k)) continue;
    if (!quotaCanDispatch(k.deploymentId, now)) continue;
    const st = KEY_STATE[idx];
    if (!keyRateLimitStatus(k, st, now).allowed) continue;
    if (!vendorUnboundedKeyConcurrency(vendor) && st.inflight >= st.cap) continue;
    if (now < st.badUntil) continue;
    // Per (key × model) dead-model cooldown — same key may still serve other
    // models, but this specific model is known-bad on this key.
    if (requestedModel) {
      const expiry = st.deadModels.get(requestedModel.toLowerCase());
      if (expiry && now < expiry) continue;
      if (expiry && now >= expiry) st.deadModels.delete(requestedModel.toLowerCase());
    }
    const available = vendorUnboundedKeyConcurrency(vendor) ? Infinity : st.cap - st.inflight;
    if (preferHigherWeight) {
      const weight = Number.isFinite(Number(k.baseWeight)) ? Number(k.baseWeight) : 1;
      if (weight > bestWeight || (weight === bestWeight && available > bestAvailable)) {
        bestWeight = weight;
        bestAvailable = available;
        bestIdx = idx;
      }
      continue;
    }
    if (rrIdx === -1 && available >= RR_THRESHOLD) {
      rrIdx = idx;
      break; // RR-strict: first eligible wins
    }
    if (available > bestAvailable) {
      bestAvailable = available;
      bestIdx = idx;
    }
  }
  if (rrIdx !== -1) bestIdx = rrIdx;
  if (bestIdx === -1) return null;

  const tracksModelSlot = !vendorUnboundedModelConcurrency(vendor);
  if (tracksModelSlot && !acquireModelSlot(requestedModel)) return null;
  if (!consumeRateLimit(
    KEY_STATE[bestIdx],
    KEY_POOL[bestIdx].rateLimitPolicy || null,
    now,
  )) {
    if (tracksModelSlot) releaseModelSlot(requestedModel);
    return null;
  }
  KEY_STATE[bestIdx].inflight++;
  keyCursor = (bestIdx + 1) % N;
  const k = KEY_POOL[bestIdx];
  return {
    idx: bestIdx,
    deploymentId: k.deploymentId || `${k.vendor}-${bestIdx + 1}`,
    name: k.name,
    value: k.value,
    host: k.host,
    vendor: k.vendor,
    quotaPolicy: k.quotaPolicy || null,
    quotaSignalProfile: k.quotaSignalProfile || '',
    fallbackAdmission: k.fallbackAdmission || 'always',
    modelAliases: k.modelAliases || null,
    apiFormats: k.apiFormats || null,
    authType: k.authType || null,
    requestPolicy: k.requestPolicy || null,
    pathPrefix: k.pathPrefix || '',
    proto: k.proto || 'https',
    port: k.port || (k.proto === 'http' ? 80 : 443),
    useProxy: k.useProxy === true,
    proxyUrl: k.proxyUrl || null,
    chatgptAccountId: k.chatgptAccountId || null,
  };
}

function ordinaryKeyAdmissionAllowed(key, vendor, requestedModel, format, now = Date.now()) {
  return ordinaryCandidateAdmitted({
    candidate: key,
    keyPool: KEY_POOL,
    vendor,
    requestedModel,
    format,
    quotaStatus: (deploymentId) => QUOTA_MANAGER.status(deploymentId, now),
  });
}

// Direct bridges bypass local admission caps but retain upstream cooldowns.
function vendorUnboundedModelConcurrency(vendor) {
  return VENDORS[vendor]?.unboundedModelConcurrency === true;
}
function vendorUnboundedKeyConcurrency(vendor) {
  return VENDORS[vendor]?.unboundedKeyConcurrency === true;
}

// Release one in-flight slot and delegate all AIMD/cooldown transitions to
// key-state.mjs so direct and logical dispatch share one outcome policy.
function releaseKey(idx, status, retryAfterMs, requestedModel) {
  if (idx == null || idx < 0 || idx >= KEY_STATE.length) return;
  const state = KEY_STATE[idx];
  const key = KEY_POOL[idx];
  const vendor = key.vendor;
  const capMin = key.capMin != null ? key.capMin : vendorCap(vendor, 'min');
  const capMax = key.capMax != null ? key.capMax : vendorCap(vendor, 'max');
  releaseKeyCapacityOnly(idx, requestedModel);
  applyKeyOutcome({
    state,
    key,
    status,
    retryAfterMs,
    requestedModel,
    capMin,
    capMax,
    auth401CooldownMs: get401CooldownMs(vendor),
    policy: {
      outcomesLength: OUTCOMES_LEN,
      capHistoryLength: CAP_HISTORY_LEN,
      capGrowAfter: CAP_GROW_AFTER_N,
      cooldown429DefaultMs: KEY_429_COOLDOWN_DEFAULT_MS,
      cooldown429MaxMs: KEY_429_COOLDOWN_MAX_MS,
      model403CooldownMs: RELAY_MODEL_403_COOLDOWN_MS,
      cooldown403Ms: KEY_403_COOLDOWN_MS,
      consecutive403Threshold: CONSEC_403_THRESHOLD,
      cooldown5xxMs: KEY_5XX_COOLDOWN_MS,
      persistent5xxCooldownMs: KEY_5XX_PERSISTENT_COOLDOWN_MS,
      consecutive5xxThreshold: CONSEC_5XX_THRESHOLD,
      consecutiveErrorThreshold: CONSEC_ERR_THRESHOLD,
      burstErrorCooldownMs: KEY_BURST_ERR_COOLDOWN_MS,
      deadModelCooldownMs: DEAD_MODEL_COOLDOWN_MS,
    },
  });
  if (state.badUntil > 0) scheduleKeyCooldownPersist();
}

function releaseKeyCapacityOnly(idx, requestedModel) {
  if (idx == null || idx < 0 || idx >= KEY_STATE.length) return;
  KEY_STATE[idx].inflight = Math.max(0, KEY_STATE[idx].inflight - 1);
  if (!vendorUnboundedModelConcurrency(KEY_POOL[idx]?.vendor)) {
    releaseModelSlot(requestedModel);
  }
}

function acquireModelSlot(modelName) {
  const policy = realModelPolicy(MODEL_POLICY, modelName);
  if (!policy) return true;
  const model = policy.name.toLowerCase();
  const active = MODEL_INFLIGHT.get(model) || 0;
  if (active >= policy.maxInflight) return false;
  MODEL_INFLIGHT.set(model, active + 1);
  return true;
}

function releaseModelSlot(modelName) {
  const policy = realModelPolicy(MODEL_POLICY, modelName);
  if (!policy) return;
  const model = policy.name.toLowerCase();
  const next = Math.max(0, (MODEL_INFLIGHT.get(model) || 1) - 1);
  if (next === 0) MODEL_INFLIGHT.delete(model);
  else MODEL_INFLIGHT.set(model, next);
}

function keyPoolStatus() {
  return buildKeyPoolStatus({
    keys: KEY_POOL,
    states: KEY_STATE,
    stickyRuntime: STICKY_PROXY_RUNTIME,
    quotaStatus: (deploymentId, now) => QUOTA_MANAGER.status(deploymentId, now),
    exposeUpstreamHosts: EXPOSE_UPSTREAM_HOSTS,
  });
}

const LOGICAL_DEPLOYMENTS = createLogicalDeploymentRegistry({
  getRuntime: () => ({
    vendors: VENDORS,
    keyPool: KEY_POOL,
    keyState: KEY_STATE,
    modelPolicy: MODEL_POLICY,
    quotaManager: QUOTA_MANAGER,
    quotaPersistenceHealthy: QUOTA_PERSISTENCE_HEALTHY,
    stickyRuntime: STICKY_PROXY_RUNTIME,
    candidateQualifications: CANDIDATE_QUALIFICATIONS,
    modelInflight: MODEL_INFLIGHT,
    logicalScheduler: LOGICAL_SCHEDULER,
    timeRouteScheduler: TIME_ROUTE_SCHEDULER,
  }),
  vendorCap,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  keyRuntimeAvailable,
  quotaCanDispatch,
  keyRateLimitStatus,
  consumeRateLimit,
  vendorUnboundedModelConcurrency,
  acquireModelSlot,
  releaseModelSlot,
  advanceKeyCursor: (keyIndex, poolLength) => {
    keyCursor = (keyIndex + 1) % poolLength;
  },
  releaseKey,
});

const MODEL_INVENTORY = createModelInventory({
  getRuntime: () => ({
    vendors: VENDORS,
    keyPool: KEY_POOL,
    keyState: KEY_STATE,
    modelPolicy: MODEL_POLICY,
    quotaManager: QUOTA_MANAGER,
    quotaPersistenceHealthy: QUOTA_PERSISTENCE_HEALTHY,
    stickyRuntime: STICKY_PROXY_RUNTIME,
    candidateQualifications: CANDIDATE_QUALIFICATIONS,
    modelInflight: MODEL_INFLIGHT,
  }),
  logicalDeployments: LOGICAL_DEPLOYMENTS,
  vendorCap,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  keyRateLimitStatus,
  logicalScheduler: LOGICAL_SCHEDULER,
});
const {
  buildModelInventory,
  buildLogicalModelInventory,
  buildLogicalRoutePlan,
} = MODEL_INVENTORY;

function resetKeyDailyStats() {
  for (const st of KEY_STATE) {
    st.total2xx = 0;
    st.total429 = 0;
    st.total401 = 0;
    st.total403 = 0;
    st.total5xx = 0;
    st.totalNetErr = 0;
    st.outcomes = [];
    // intentionally NOT resetting: cap, consec2xx, capHistory, consec403,
    // consecErr, deadModels — those are learned state, not daily metrics.
  }
}

// ---- Upstream header policy ----
const pickHeaders = createUpstreamHeaderPolicy({
  // Optional fallback only when a downstream request has no User-Agent.
  // An ordinary relay otherwise preserves the downstream value verbatim.
  defaultUserAgent: process.env.TOMATO_TAP_DEFAULT_USER_AGENT || '',
});

// ---- Usage log + dashboard ----
// usage.log is the durable terminal/attempt ledger; USAGE_DASHBOARD keeps
// today's in-memory aggregates (route/vendor/model) and renders GET /__usage.
const USAGE_LEDGER = createUsageLedger({ path: USAGE_LOG, env: process.env });
const USAGE_DASHBOARD = createUsageDashboard({
  pricing: MODEL_PRICING,
  // Infer vendor for legacy rows that only record a key name.
  vendorByKey: (name) => KEY_POOL.find((key) => key.name === name)?.vendor || null,
  providerByKey: (name) => USAGE_PROVIDER_BY_KEY.get(name) || null,
  providerByDeployment: (id) => USAGE_PROVIDER_BY_DEPLOYMENT.get(id) || null,
});
const USAGE_HISTORY = createUsageHistory({
  path: USAGE_LOG,
  pricing: MODEL_PRICING,
  vendorByKey: (name) => KEY_POOL.find((key) => key.name === name)?.vendor || null,
  providerByKey: (name) => USAGE_PROVIDER_BY_KEY.get(name) || null,
  providerByDeployment: (id) => USAGE_PROVIDER_BY_DEPLOYMENT.get(id) || null,
});
const REQUEST_ACCOUNTING = createRequestAccounting({
  ledger: USAGE_LEDGER,
  dashboard: USAGE_DASHBOARD,
  pricing: MODEL_PRICING,
  budgetManager: BUDGET_MANAGER,
  extractUsage,
  getVendors: () => VENDORS,
  providerByKey: (name) => USAGE_PROVIDER_BY_KEY.get(name) || null,
  providerByDeployment: (id) => USAGE_PROVIDER_BY_DEPLOYMENT.get(id) || null,
});
const {
  appendUsage,
  recordLogicalAttempt,
  recordLogicalUsage,
  recordOrdinaryTerminal,
  recordOrdinaryExhausted,
} = REQUEST_ACCOUNTING;
// ---- Retry configuration ----
// On upstream 401/429/5xx/network-error, proxy picks a different key (exclude
// set) and retries. Client only sees a failure when the entire retry budget
// is exhausted. 4xx responses other than 401 (e.g. 400 safety reject) are
// content-deterministic and propagate directly — retrying would re-fail.
//
// Tradeoff: request body and response body must be buffered (not streamed
// chunk-by-chunk to the client). For non-streaming JSON responses the latency
// hit is negligible; for SSE streams the client loses progressive delivery
// but gains retry coverage. Net win — see /__status retry_stats_today.
const MAX_RETRIES = 3;                                // first attempt + 3 retries = 4 attempts max
const RETRY_BACKOFF_MS = [0, 80, 250, 600];           // sleep before attempts 1..3 when pool was empty
const RETRYABLE_STATUSES = new Set([401, 429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function freshRetryStats() {
  return {
    no_retry: 0,             // succeeded on first attempt
    retried_1_success: 0,    // succeeded on attempt #2
    retried_2_success: 0,    // succeeded on attempt #3
    retried_3_success: 0,    // succeeded on attempt #4
    all_attempts_failed: 0,  // every attempt returned a retryable failure
    pool_exhausted: 0,       // could not even acquire a key (503 to client)
  };
}
let retryStats = freshRetryStats();
function recordSuccess(attemptIndex) {
  if (attemptIndex === 0) retryStats.no_retry++;
  else if (attemptIndex === 1) retryStats.retried_1_success++;
  else if (attemptIndex === 2) retryStats.retried_2_success++;
  else retryStats.retried_3_success++;
}

// Shared buffered transport for direct and proxied upstreams.
const SHARED_PROXY_URL = process.env.TOMATO_TAP_SHARED_PROXY_URL
  || process.env.HTTPS_PROXY
  || process.env.https_proxy
  || '';
const SHARED_PROXY_VENDOR = process.env.TOMATO_TAP_SHARED_PROXY_VENDOR || '';
const UPSTREAM_HTTP = createUpstreamHttpTransport({
  sharedProxyUrl: SHARED_PROXY_URL,
  sharedProxyVendor: SHARED_PROXY_VENDOR,
  maxResponseBytes: GATEWAY_LIMITS.maxResponseBytes,
});
if (SHARED_PROXY_URL) {
  const scope = SHARED_PROXY_VENDOR
    ? `vendor=${SHARED_PROXY_VENDOR}`
    : 'opt-in deployments';
  console.log(`[egress] shared proxy configured for ${scope}`);
}
const sendUpstreamBuffered = UPSTREAM_HTTP.sendBuffered;

const LOGICAL_DISPATCH = createLogicalDispatcher({
  scheduler: LOGICAL_SCHEDULER,
  deployments: LOGICAL_DEPLOYMENTS,
  openSampleLog: (fileName) => SAMPLE_LOGGER.open(fileName),
  getModelPolicy: () => MODEL_POLICY,
  getVendors: () => VENDORS,
  pickHeaders,
  maskHeaders,
  sendUpstreamBuffered,
  recordQuotaRequestResult,
  parseRetryAfter,
  releaseKeyCapacityOnly,
  recordStickyProxyResult,
  recordCandidateQualification,
  recordRetrySuccess: recordSuccess,
  recordAllAttemptsFailed: () => { retryStats.all_attempts_failed += 1; },
  recordLogicalAttempt,
  recordLogicalUsage,
});

const ORDINARY_DISPATCH = createOrdinaryDispatcher({
  maxRetries: MAX_RETRIES,
  retryBackoffMs: RETRY_BACKOFF_MS,
  retryableStatuses: RETRYABLE_STATUSES,
  openSampleLog: (fileName) => SAMPLE_LOGGER.open(fileName),
  getRuntime: () => ({
    keyPool: KEY_POOL,
    keyState: KEY_STATE,
    vendors: VENDORS,
    modelPolicy: MODEL_POLICY,
  }),
  pickKeyAndAcquire,
  keyRuntimeAvailable,
  quotaCanDispatch,
  candidateAdmissionAllowed: (candidate, vendor, requestedModel, format, now) => (
    ordinaryCandidateAdmitted({
      candidate,
      keyPool: KEY_POOL,
      vendor,
      requestedModel,
      format,
      quotaStatus: (deploymentId) => QUOTA_MANAGER.status(deploymentId, now),
    })
  ),
  rateLimitCanDispatch: (key, state, now) => keyRateLimitStatus(key, state, now).allowed,
  keyPoolStatus,
  pickHeaders,
  maskHeaders,
  sendUpstreamBuffered,
  recordStickyProxyResult,
  recordQuotaRequestResult,
  recordCandidateQualification,
  parseRetryAfter,
  releaseKey,
  releaseKeyCapacityOnly,
  rejectInvalidRequest: (clientRes, message, route) => rejectLogical(
    clientRes,
    400,
    'mimo_tap_invalid_chat_request',
    message,
    { route: route.prefix },
  ),
  recordRetrySuccess: recordSuccess,
  recordPoolExhausted: () => { retryStats.pool_exhausted += 1; },
  recordAllAttemptsFailed: () => { retryStats.all_attempts_failed += 1; },
  recordTerminal: recordOrdinaryTerminal,
  recordExhausted: recordOrdinaryExhausted,
  timeouts: {
    firstByteTimeoutMs: GATEWAY_LIMITS.ordinaryFirstByteTimeoutMs,
    totalTimeoutMs: GATEWAY_LIMITS.ordinaryTotalTimeoutMs,
  },
});

async function dispatchWithRetry(clientReq, clientRes, id, ts, url, pathPrefix, format, reqBuf, vendor, route) {
  const requestedModel = extractRequestModel(reqBuf);
  const taskName = gatewayHeader(clientReq.headers, 'task');
  let logicalRequest;
  try {
    logicalRequest = resolveLogicalRequest(MODEL_POLICY, requestedModel, taskName);
  } catch (error) {
    return rejectLogical(clientRes, 400, 'mimo_tap_invalid_logical_request', error.message, {
      logical_model: requestedModel,
    });
  }
  if (logicalRequest) {
    const clientError = validateLogicalClientRequest(reqBuf, clientReq.headers);
    if (clientError) {
      return rejectLogical(clientRes, 400, 'mimo_tap_invalid_logical_request', clientError, {
        logical_model: requestedModel,
      });
    }
    return LOGICAL_DISPATCH({
      clientReq,
      clientRes,
      id,
      ts,
      url,
      reqBuf,
      logicalRequest,
      routePrefix: route.prefix,
    });
  }

  return ORDINARY_DISPATCH({
    clientReq,
    clientRes,
    id,
    ts,
    url,
    format,
    reqBuf,
    vendor,
    route,
    requestedModel,
  });
}

function buildStatusPayload() {
  const remaining = Math.max(0, budget.total - budget.used);
  const logicalEligibility = buildLogicalModelInventory({ now: Date.now() });
  return {
    used: budget.used,
    total: budget.total,
    remaining,
    pct_used: budget.total ? +(100 * budget.used / budget.total).toFixed(2) : 0,
    in_window: inWindow(),
    window_utc: `${WINDOW_START_UTC_HOUR}:00-${WINDOW_END_UTC_HOUR}:00`,
    offpeak_mult: OFFPEAK_MULT,
    access: {
      mode: 'trusted',
      client_auth: false,
      bind_host: BIND_HOST,
    },
    gateway_limits: {
      max_request_bytes: GATEWAY_LIMITS.maxRequestBytes,
      max_response_bytes: GATEWAY_LIMITS.maxResponseBytes,
      ordinary_first_byte_timeout_ms: GATEWAY_LIMITS.ordinaryFirstByteTimeoutMs,
      ordinary_total_timeout_ms: GATEWAY_LIMITS.ordinaryTotalTimeoutMs,
      server_request_timeout_ms: GATEWAY_LIMITS.serverRequestTimeoutMs,
      server_headers_timeout_ms: GATEWAY_LIMITS.serverHeadersTimeoutMs,
      server_keep_alive_timeout_ms: GATEWAY_LIMITS.serverKeepAliveTimeoutMs,
      shutdown_grace_timeout_ms: GATEWAY_LIMITS.shutdownGraceTimeoutMs,
      server_max_requests_per_socket: GATEWAY_LIMITS.serverMaxRequestsPerSocket,
    },
    usage_log: USAGE_LEDGER.status(),
    state_layout: {
      state_dir: STATE_DIR,
      runtime_dir: RUNTIME_STATE_DIR,
      legacy_layout: STATE_LAYOUT.legacyLayout,
      explicit: STATE_LAYOUT.explicit,
    },
    sample_logging: SAMPLE_LOGGER.status(),
    cursor_acp: CURSOR_ACP_BRIDGE.snapshot(),
    by_model: budget.by_model,
    key_pool: keyPoolStatus(),
    quota_windows: QUOTA_MANAGER.snapshot(),
    quota_persistence_healthy: QUOTA_PERSISTENCE_HEALTHY,
    cooldown_persistence_healthy: KEY_COOLDOWN_PERSISTENCE_HEALTHY,
    cooldowns_restored_at_boot: RESTORED_KEY_COOLDOWNS,
    retry_stats_today: retryStats,
    logical_scheduler: {
      policies: [...MODEL_POLICY.logicalModels.keys()],
      model_inflight: Object.fromEntries(MODEL_INFLIGHT),
      runtime: LOGICAL_SCHEDULER.snapshot(Date.now()),
    },
    time_routes: TIME_ROUTE_SCHEDULER.snapshot(Date.now()),
    candidate_eligibility: {
      logical_models: Object.fromEntries(logicalEligibility.map((model) => [model.id, {
        health: model.health,
        ...model.qualification,
      }])),
      validated_pairs: CANDIDATE_QUALIFICATIONS.snapshot(),
    },
    runtime_config: {
      ...RUNTIME_GENERATION.status(),
      watcher: RUNTIME_CONFIG_WATCHER.status(),
      config_backend: RUNTIME_CONFIG.configBackend,
    },
    quota_infer_counts: { ...quotaInferCounts },
    quota_infer_events: [...quotaInferEvents],
    vendor_spend_today: { ...vendorSpendToday },
    vendor_constraints: Object.fromEntries(
      Object.entries(VENDORS)
        .filter(([, vendor]) => vendor.constraints)
        .map(([id, vendor]) => [id, {
          peakHoursUTC: vendor.constraints.peakHoursUTC,
          disabledInPeak: vendor.constraints.disabledInPeak,
          offPeakWeekends: vendor.pricing?.offPeakWeekends === true,
          billingUtcOffsetMinutes: Number(vendor.pricing?.billingUtcOffsetMinutes || 0),
          currentPriceBand: isVendorPeakPeriod(vendor) ? 'peak' : 'off_peak',
          dailyCnyCap: vendor.constraints.dailyCnyCap,
          spent: (() => {
            const entry = vendorSpendToday[id];
            if (!entry || typeof entry !== 'object') return 0;
            return Number(entry.credits || 0)
              + Number(entry.cny || 0)
              + Number(entry.reservedCny || 0);
          })(),
          blocked: checkVendorConstraints(id, vendor),
        }]),
    ),
    now_utc: new Date().toISOString(),
  };
}

async function reloadAdminRuntime() {
  await RUNTIME_CONFIG_WATCHER.check();
  RUNTIME_GENERATION.tryActivate();
  await RUNTIME_GENERATION.waitForActivation(10_000);
  return {
    ...RUNTIME_GENERATION.status(),
    watcher: RUNTIME_CONFIG_WATCHER.status(),
  };
}

const ADMIN_CONSOLE = createAdminConsole({
  configStore: OPERATOR_CONFIG_STORE,
  getStatusPayload: buildStatusPayload,
  getPhysicalModels: () => buildModelInventory(),
  getLogicalModels: () => buildLogicalModelInventory({ now: Date.now() }),
  getUsageToday: () => USAGE_DASHBOARD.snapshot(),
  reloadRuntime: reloadAdminRuntime,
  bindHost: BIND_HOST,
  adminToken: process.env.TOMATO_TAP_ADMIN_TOKEN || '',
  detailLevel: ADMIN_DETAIL_LEVEL,
});

const CONTROL_PLANE = createControlPlaneHandler({
  getStatusPayload: buildStatusPayload,
  usageDashboard: USAGE_DASHBOARD,
  usageHistory: USAGE_HISTORY,
  modelPricing: MODEL_PRICING,
  getRealModels: () => [...MODEL_POLICY.realModels.values()],
  buildModelInventory,
  buildLogicalModelInventory,
  buildLogicalRoutePlan,
  adminConsole: ADMIN_CONSOLE,
});

const GATEWAY_REQUEST_HANDLER = createGatewayRequestHandler({
  port: PORT,
  controlPlane: CONTROL_PLANE,
  routeForPath,
  getVendors: () => VENDORS,
  runtimeGeneration: RUNTIME_GENERATION,
  inWindow,
  windowStartUtcHour: WINDOW_START_UTC_HOUR,
  windowEndUtcHour: WINDOW_END_UTC_HOUR,
  getBudget: () => budget,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  estimateRequestReserveCny,
  checkVendorCnyReservation,
  reserveVendorCny,
  releaseVendorCny,
  persistVendorSpend: () => {
    budget.vendor_spend_today = vendorSpendToday;
    saveBudget(budget);
  },
  extractRequestedModel,
  dispatchRequest: dispatchWithRetry,
  maxRequestBytes: GATEWAY_LIMITS.maxRequestBytes,
});

const server = http.createServer(GATEWAY_REQUEST_HANDLER);
server.requestTimeout = GATEWAY_LIMITS.serverRequestTimeoutMs;
server.headersTimeout = GATEWAY_LIMITS.serverHeadersTimeoutMs;
server.keepAliveTimeout = GATEWAY_LIMITS.serverKeepAliveTimeoutMs;
server.maxRequestsPerSocket = GATEWAY_LIMITS.serverMaxRequestsPerSocket;
server.maxHeadersCount = 200;
server.listen(PORT, BIND_HOST, () => {
  RUNTIME_CONFIG_WATCHER.start();
  listUsageLogFiles(USAGE_LOG)
    .then((paths) => USAGE_DASHBOARD.scanTodayFromLog(paths))
    .then((n) => {
      console.log(`[usage-dashboard] backfilled ${n} today rows from usage ledger`);
    })
    .catch((error) => {
      console.warn(`[usage-dashboard] startup backfill failed: ${String(error?.message || error).slice(0, 256)}`);
    });
  USAGE_HISTORY.sync().then((n) => {
    console.log(`[usage-history] initial sync ${n} rows (${JSON.stringify(USAGE_HISTORY.snapshotStats())})`);
  }).catch((error) => {
    console.warn(`[usage-history] initial sync failed: ${String(error?.message || error).slice(0, 256)}`);
  });
  setInterval(() => { USAGE_HISTORY.sync().catch(() => {}); }, 30_000).unref();
  // Safety net for SIGKILL/OOM: at most 30s of cooldown state is lost.
  setInterval(() => { persistKeyCooldowns(); }, 30_000).unref();
  console.log(`tomato-tap listening on http://${BIND_HOST}:${PORT} access=trusted`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(BIND_HOST)) {
    console.warn('[security] trusted mode is listening beyond loopback; restrict access with the host firewall or trusted network policy');
  }
  for (const [vname, vcfg] of Object.entries(VENDORS)) {
    const n = KEY_POOL.filter((k) => k.vendor === vname).length;
    const paths = vcfg.routes.map((r) => `http://${BIND_HOST}:${PORT}${r.prefix}`).join(', ');
    const upstream = EXPOSE_UPSTREAM_HOSTS ? vcfg.defaultHost : '[redacted]';
    console.log(`  ${vname.padEnd(8)} -> ${paths}  (${n} keys, upstream=${upstream})`);
  }
  console.log(`  status   -> http://${BIND_HOST}:${PORT}/__status`);
  console.log(`  health   -> http://${BIND_HOST}:${PORT}/healthz  readiness=/readyz`);
  console.log(`  explain  -> http://${BIND_HOST}:${PORT}/__route/plan?model=balanced`);
  console.log(`  console  -> http://${BIND_HOST}:${PORT}/admin/`);
  if (CURSOR_ACP_BRIDGE.enabled) {
    const address = CURSOR_ACP_BRIDGE.address();
    console.log(`  cursor   -> http://${address.host}:${address.port}/v1 (model=cursor-agent)`);
  }
  console.log(`  window    UTC ${WINDOW_START_UTC_HOUR}:00-${WINDOW_END_UTC_HOUR}:00 | mult=${OFFPEAK_MULT}`);
  console.log(`  budget    ${budget.used}/${budget.total} credits   in_window=${inWindow()}`);
  console.log(`  retry     max_attempts=${MAX_RETRIES + 1}  backoff_ms=[${RETRY_BACKOFF_MS.join(',')}]  retryable=[${[...RETRYABLE_STATUSES].sort((a,b)=>a-b).join(',')}]`);
  const sampleStatus = SAMPLE_LOGGER.status();
  console.log(`  samples   enabled=${sampleStatus.enabled} retention_ms=${sampleStatus.retention_ms} max_bytes=${sampleStatus.max_bytes}`);
  console.log(`  limits    request=${GATEWAY_LIMITS.maxRequestBytes}B response=${GATEWAY_LIMITS.maxResponseBytes}B ordinary_deadline=${GATEWAY_LIMITS.ordinaryTotalTimeoutMs}ms`);
  console.log(`  key_pool  ${KEY_POOL.length} keys × cap=AIMD[${PER_KEY_CAP_INITIAL}→${PER_KEY_CAP_MAX}]  (initial ${KEY_POOL.length * PER_KEY_CAP_INITIAL} → max ${KEY_POOL.length * PER_KEY_CAP_MAX} concurrent)`);
  console.log(`  selection shortest-queue-first + RR tiebreak  |  https keep-alive`);
  if (KEY_POOL.length > 0 && LOG_KEY_INVENTORY) {
    for (const k of KEY_POOL) {
      console.log(`            ${k.name} → ${k.host}`);
    }
  } else if (KEY_POOL.length > 0) {
    console.log('            per-key startup inventory hidden (set TOMATO_TAP_LOG_KEY_INVENTORY=true to show)');
  } else {
    console.log('            no upstream credentials configured; model calls return 503');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  RUNTIME_CONFIG_WATCHER.stop();
  SAMPLE_LOGGER.close();
  BUDGET_MANAGER.close();
  PENDING_STICKY_RUNTIME?.dispose?.(); // staged-but-never-activated generation
  console.log(`[tomato-tap] ${signal}: draining requests before shutdown`);
  server.close(async () => {
    persistCandidateQualifications();
    persistQuotaState();
    persistKeyCooldowns();
    UPSTREAM_HTTP.close();
    await USAGE_LEDGER.close();
    await QUOTA_CONTROL_SERVER.close();
    await STICKY_PROXY_RUNTIME.stopAll();
    await CURSOR_ACP_BRIDGE.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => {
    persistCandidateQualifications();
    persistKeyCooldowns();
    UPSTREAM_HTTP.close();
    USAGE_LEDGER.close()
      .then(() => QUOTA_CONTROL_SERVER.close())
      .then(() => STICKY_PROXY_RUNTIME.stopAll())
      .then(() => CURSOR_ACP_BRIDGE.close())
      .finally(() => process.exit(1));
  }, GATEWAY_LIMITS.shutdownGraceTimeoutMs).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
function get401CooldownMs(vendor) {
  const override = VENDORS[vendor]?.auth401CooldownMs;
  return Number.isFinite(override) && override >= 0 ? override : KEY_401_COOLDOWN_MS;
}

function positiveInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`expected a positive integer, got ${value}`);
  }
  return number;
}

function decodeOptionalBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8').trim() || raw;
  } catch {
    return raw;
  }
}
