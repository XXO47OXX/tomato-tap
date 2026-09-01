// vendor-loader.mjs
//
// Compiles ./vendors.json into the runtime shapes used by the gateway:
//   - VENDORS                : { id → { envPrefix, envDiscovery, envDumpPath,
//                                       defaultHost, routes:[{prefix, format,
//                                       rewrite, upstreamPathPrefix?, setAuth, injectBody?,
//                                       transformResponse?}], preserveIncomingHeaders?,
//                                       preserveIncomingUserAgent?,
//                                       preserveIncomingBody?, logicalEligible?,
//                                       retryPolicy?, requestTimeouts? } }
//   - VENDOR_CAP_OVERRIDES   : { id → { initial?, min?, max?, vendorMaxInflight? } }
//
// Function references (auth, injectBody, transformResponse) are resolved
// against a caller-supplied `registry` via dependency injection — the loader
// never imports the application composition root, so dependency flow stays one-way.
//
// Adding a vendor = append a record to vendors.json (+ .env entries).
// Loader is intentionally strict: invalid config throws at startup, never
// produces a partially-broken VENDORS dict that silently misroutes.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PATH = join(PROJECT_ROOT, 'config', 'vendors.json');

const SUPPORTED_SCHEMA = 1;
const VALID_ENV_DISCOVERY = new Set(['single', 'multi', 'dump_file']);
const VALID_API_FORMATS   = new Set(['openai', 'anthropic', 'openai_responses']);

/**
 * Load and compile vendors.json.
 *
 * @param {{auth: object, inject?: object, transform?: object}} registry
 *   Function tables. `auth` is REQUIRED; `inject` / `transform` are required
 *   only when at least one vendor references them.
 * @param {{path?: string}} [opts]
 * @returns {{VENDORS: object, VENDOR_CAP_OVERRIDES: object, schemaVersion: number}}
 */
export function loadVendors(registry, opts = {}) {
  if (!registry || !registry.auth) {
    throw new Error('vendor-loader: registry.auth is required');
  }
  const path = opts.path || DEFAULT_PATH;
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  if (raw.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(
      `vendor-loader: unsupported schemaVersion ${raw.schemaVersion} ` +
      `(expected ${SUPPORTED_SCHEMA})`,
    );
  }
  const capPolicies = raw.capPolicies || {};
  if (!Array.isArray(raw.vendors) || raw.vendors.length === 0) {
    throw new Error('vendor-loader: vendors[] must be a non-empty array');
  }

  const VENDORS = {};
  const VENDOR_CAP_OVERRIDES = {};

  for (const v of raw.vendors) {
    const id = v.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('vendor-loader: every vendor must have a string id');
    }
    if (VENDORS[id]) {
      throw new Error(`vendor-loader: duplicate vendor id "${id}"`);
    }
    // `enabled: false` (default true) skips the vendor entirely — no routes
    // registered, no keys discovered. Use to park a vendor whose upstream is
    // dead (key revoked / quota exhausted / service shut down) without
    // deleting its config; flip back to true to revive.
    if (v.enabled === false) {
      console.log(`[vendor-loader] skipping disabled vendor "${id}"`);
      continue;
    }
    VENDORS[id]              = compileVendor(v, registry);
    const override           = compileCapOverride(v, capPolicies);
    if (override) VENDOR_CAP_OVERRIDES[id] = override;
    if (v.noProxy)           warnIfMissingFromNoProxy(v);
  }

  return { VENDORS, VENDOR_CAP_OVERRIDES, schemaVersion: raw.schemaVersion };
}

// ---- Per-vendor compilation -----------------------------------------------

function compileVendor(v, registry) {
  const envDiscovery = v.envDiscovery || 'single';
  if (!VALID_ENV_DISCOVERY.has(envDiscovery)) {
    throw new Error(
      `vendor-loader: vendor "${v.id}" envDiscovery="${envDiscovery}" ` +
      `(expected one of ${[...VALID_ENV_DISCOVERY].join(', ')})`,
    );
  }
  if (envDiscovery === 'dump_file' && !v.envDumpPath) {
    throw new Error(`vendor-loader: vendor "${v.id}" envDiscovery=dump_file requires envDumpPath`);
  }
  if (envDiscovery !== 'dump_file' && !v.envPrefix) {
    throw new Error(`vendor-loader: vendor "${v.id}" requires envPrefix when envDiscovery="${envDiscovery}"`);
  }
  if (!Array.isArray(v.routes) || v.routes.length === 0) {
    throw new Error(`vendor-loader: vendor "${v.id}" routes[] must be a non-empty array`);
  }
  if (v.nativeModels !== undefined &&
      (!Array.isArray(v.nativeModels) || v.nativeModels.some((m) => typeof m !== 'string'))) {
    throw new Error(`vendor-loader: vendor "${v.id}" nativeModels must be string[] when present`);
  }
  const pricing = compilePricing(v);
  const retryPolicy = compileRetryPolicy(v);
  const requestTimeouts = compileRequestTimeouts(v);
  // usageConstraints: optional per-vendor time windows + daily budget.
  // peakHoursUTC: [[startHour,endHour], ...] — vendor is gated during these windows.
  // dailyCnyCap: number — max CNY/day for this vendor (0 = unlimited).
  let constraints = null;
  if (v.usageConstraints) {
    const uc = v.usageConstraints;
    if (uc.peakHoursUTC !== undefined) {
      if (!Array.isArray(uc.peakHoursUTC) || uc.peakHoursUTC.some(
        (w) => !Array.isArray(w) || w.length !== 2 || typeof w[0] !== 'number' || typeof w[1] !== 'number')) {
        throw new Error(`vendor-loader: vendor "${v.id}" usageConstraints.peakHoursUTC must be [[number,number],...]`);
      }
    }
    constraints = {
      peakHoursUTC: uc.peakHoursUTC ? [...uc.peakHoursUTC.map(([s, e]) => [s, e])] : null,
      dailyCnyCap: typeof uc.dailyCnyCap === 'number' && uc.dailyCnyCap > 0 ? uc.dailyCnyCap : 0,
      disabledInPeak: uc.disabledInPeak === true,
    };
  }

  return {
    envPrefix:    v.envPrefix ? new RegExp(v.envPrefix, 'i') : undefined,
    envDiscovery,
    envDumpPath:  v.envDumpPath,
    defaultHost:  v.defaultHost ?? null,
    nativeModels: v.nativeModels ? [...v.nativeModels] : null,
    preserveIncomingHeaders: v.preserveIncomingHeaders === true,
    preserveIncomingUserAgent: v.preserveIncomingUserAgent === true
      || v.preserveIncomingHeaders === true,
    preserveIncomingBody: v.preserveIncomingBody === true,
    unboundedModelConcurrency: v.unboundedModelConcurrency === true,
    unboundedKeyConcurrency: v.unboundedKeyConcurrency === true,
    preferHigherWeight: v.preferHigherWeight === true,
    // Dedicated bridges opt out of logical scheduling.
    logicalEligible: v.logicalEligible !== false,
    retryPolicy,
    requestTimeouts,
    auth401CooldownMs: compileAuth401Cooldown(v),
    constraints,
    pricing,
    routes:       v.routes.map((r, idx) => compileRoute(r, registry, v.id, idx)),
  };
}

function compileAuth401Cooldown(v) {
  if (v.auth401CooldownMs === undefined) return null;
  const value = v.auth401CooldownMs;
  if (!Number.isInteger(value) || value < 0 || value > 7 * 24 * 60 * 60 * 1000) {
    throw new Error(
      `vendor-loader: vendor "${v.id}" auth401CooldownMs `
      + 'must be an integer from 0 to 604800000',
    );
  }
  return value;
}

function compileRequestTimeouts(v) {
  if (v.requestTimeouts === undefined) return null;
  const policy = v.requestTimeouts;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`vendor-loader: vendor "${v.id}" requestTimeouts must be an object`);
  }
  const firstByteMs = policy.firstByteMs;
  const totalMs = policy.totalMs;
  for (const [field, value] of [['firstByteMs', firstByteMs], ['totalMs', totalMs]]) {
    if (!Number.isInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
      throw new Error(
        `vendor-loader: vendor "${v.id}" requestTimeouts.${field} ` +
        'must be an integer from 1000 to 86400000',
      );
    }
  }
  if (firstByteMs > totalMs) {
    throw new Error(
      `vendor-loader: vendor "${v.id}" requestTimeouts.firstByteMs must not exceed totalMs`,
    );
  }
  return { firstByteMs, totalMs };
}

function compileRetryPolicy(v) {
  if (v.retryPolicy === undefined) return null;
  if (!v.retryPolicy || typeof v.retryPolicy !== 'object' || Array.isArray(v.retryPolicy)) {
    throw new Error(`vendor-loader: vendor "${v.id}" retryPolicy must be an object`);
  }
  const waitFor429RecoveryMs = v.retryPolicy.waitFor429RecoveryMs ?? 0;
  if (!Number.isInteger(waitFor429RecoveryMs)
      || waitFor429RecoveryMs < 0
      || waitFor429RecoveryMs > 5 * 60 * 1000) {
    throw new Error(
      `vendor-loader: vendor "${v.id}" retryPolicy.waitFor429RecoveryMs ` +
      'must be an integer from 0 to 300000',
    );
  }
  return { waitFor429RecoveryMs };
}

function compilePricing(v) {
  if (v.pricing === undefined) return null;
  const p = v.pricing;
  if (p.currency !== 'CNY') {
    throw new Error(`vendor-loader: vendor "${v.id}" pricing.currency must be "CNY"`);
  }
  if (p.unit !== 'million_tokens') {
    throw new Error(`vendor-loader: vendor "${v.id}" pricing.unit must be "million_tokens"`);
  }
  if (!Array.isArray(p.models) || p.models.length === 0) {
    throw new Error(`vendor-loader: vendor "${v.id}" pricing.models must be a non-empty array`);
  }
  if (p.offPeakWeekends !== undefined && typeof p.offPeakWeekends !== 'boolean') {
    throw new Error(`vendor-loader: vendor "${v.id}" pricing.offPeakWeekends must be boolean`);
  }
  const billingUtcOffsetMinutes = p.billingUtcOffsetMinutes === undefined
    ? 0
    : p.billingUtcOffsetMinutes;
  if (!Number.isInteger(billingUtcOffsetMinutes)
      || billingUtcOffsetMinutes < -720 || billingUtcOffsetMinutes > 840) {
    throw new Error(`vendor-loader: vendor "${v.id}" pricing.billingUtcOffsetMinutes must be an integer from -720 to 840`);
  }
  const models = p.models.map((m, idx) => {
    for (const field of ['match', 'inputCached', 'inputMiss', 'output']) {
      if (m[field] === undefined) {
        throw new Error(`vendor-loader: vendor "${v.id}" pricing.models[${idx}].${field} is required`);
      }
    }
    if (typeof m.match !== 'string' || !m.match) {
      throw new Error(`vendor-loader: vendor "${v.id}" pricing.models[${idx}].match must be a non-empty string`);
    }
    for (const field of ['inputCached', 'inputMiss', 'output']) {
      if (typeof m[field] !== 'number' || m[field] < 0) {
        throw new Error(`vendor-loader: vendor "${v.id}" pricing.models[${idx}].${field} must be a non-negative number`);
      }
    }
    return {
      match: m.match.toLowerCase(),
      inputCached: m.inputCached,
      inputMiss: m.inputMiss,
      output: m.output,
    };
  }).sort((a, b) => b.match.length - a.match.length);
  return {
    currency: p.currency,
    unit: p.unit,
    peakMultiplier: typeof p.peakMultiplier === 'number' && p.peakMultiplier > 0 ? p.peakMultiplier : 1,
    offPeakWeekends: p.offPeakWeekends === true,
    billingUtcOffsetMinutes,
    requestReserve: compileRequestReserve(v.id, p.requestReserve),
    models,
  };
}

function compileRequestReserve(vendorId, reserve) {
  if (reserve === undefined) {
    return { inputTokenEstimate: 'utf8_bytes', defaultOutputTokens: 4096 };
  }
  const inputTokenEstimate = reserve.inputTokenEstimate || 'utf8_bytes';
  if (inputTokenEstimate !== 'utf8_bytes') {
    throw new Error(`vendor-loader: vendor "${vendorId}" pricing.requestReserve.inputTokenEstimate must be "utf8_bytes"`);
  }
  const defaultOutputTokens = reserve.defaultOutputTokens === undefined ? 4096 : reserve.defaultOutputTokens;
  if (typeof defaultOutputTokens !== 'number' || defaultOutputTokens < 0) {
    throw new Error(`vendor-loader: vendor "${vendorId}" pricing.requestReserve.defaultOutputTokens must be a non-negative number`);
  }
  return { inputTokenEstimate, defaultOutputTokens };
}

function compileRoute(r, registry, vendorId, idx) {
  if (!r.prefix || typeof r.prefix !== 'string') {
    throw new Error(`vendor-loader: vendor "${vendorId}" route[${idx}] missing prefix`);
  }
  if (!VALID_API_FORMATS.has(r.apiFormat)) {
    throw new Error(
      `vendor-loader: vendor "${vendorId}" route[${idx}] apiFormat="${r.apiFormat}" ` +
      `(expected one of ${[...VALID_API_FORMATS].join(', ')})`,
    );
  }
  const out = {
    prefix:  r.prefix,
    format:  r.apiFormat,
    rewrite: buildRewrite(r.rewrite, vendorId, idx),
    setAuth: resolveRef(r.auth, registry.auth, 'auth', vendorId, idx),
  };
  if (Object.prototype.hasOwnProperty.call(r, 'upstreamPathPrefix')) {
    if (typeof r.upstreamPathPrefix !== 'string') {
      throw new Error(
        `vendor-loader: vendor "${vendorId}" route[${idx}] upstreamPathPrefix must be a string`,
      );
    }
    out.upstreamPathPrefix = r.upstreamPathPrefix;
  }
  if (r.injectBody) {
    out.injectBody = resolveRef(r.injectBody, registry.inject, 'injectBody', vendorId, idx);
  }
  if (r.transformResponse) {
    out.transformResponse = resolveRef(r.transformResponse, registry.transform, 'transformResponse', vendorId, idx);
  }
  // openai_responses without a chat↔responses round-trip pair is a config bug —
  // the upstream protocol is incompatible with the client-facing one.
  if (r.apiFormat === 'openai_responses' && !(out.injectBody && out.transformResponse)) {
    throw new Error(
      `vendor-loader: vendor "${vendorId}" route[${idx}] apiFormat=openai_responses ` +
      `requires both injectBody and transformResponse`,
    );
  }
  return out;
}

// A relay key normally supplies its upstream base path (for example
// `/anthropic`). A multi-protocol vendor can override that base per route so
// the same key slot and runtime state serve both protocols without duplicating
// credentials, cooldowns, or concurrency accounting.
export function resolveUpstreamPath(route, key, requestPath) {
  const keyPrefix = typeof key?.pathPrefix === 'string' ? key.pathPrefix : '';
  const prefix = Object.prototype.hasOwnProperty.call(route || {}, 'upstreamPathPrefix')
    ? route.upstreamPathPrefix
    : keyPrefix;
  return `${prefix}${route.rewrite(requestPath)}`;
}

function buildRewrite(rw, vendorId, idx) {
  if (rw == null) return (p) => p;                              // identity
  if (typeof rw !== 'object' || typeof rw.from !== 'string') {
    throw new Error(`vendor-loader: vendor "${vendorId}" route[${idx}] rewrite must be {from, to}`);
  }
  const re = new RegExp(rw.from);
  const to = rw.to ?? '';
  return (p) => p.replace(re, to);
}

function resolveRef(name, table, kind, vendorId, idx) {
  if (!name) throw new Error(`vendor-loader: vendor "${vendorId}" route[${idx}] missing ${kind}`);
  if (!table || !(name in table)) {
    throw new Error(`vendor-loader: vendor "${vendorId}" route[${idx}] unknown ${kind} "${name}"`);
  }
  return table[name];
}

// ---- Cap overrides --------------------------------------------------------

function compileCapOverride(v, capPolicies) {
  const override = {};
  if (v.capPolicyRef) {
    const p = capPolicies[v.capPolicyRef];
    if (!p) {
      throw new Error(`vendor-loader: vendor "${v.id}" references undefined capPolicy "${v.capPolicyRef}"`);
    }
    if (typeof p.initial === 'number') override.initial = p.initial;
    if (typeof p.min     === 'number') override.min     = p.min;
    if (typeof p.max     === 'number') override.max     = p.max;
  }
  if (typeof v.vendorMaxInflight === 'number') {
    override.vendorMaxInflight = v.vendorMaxInflight;
  }
  return Object.keys(override).length ? override : null;
}

// ---- Startup checks -------------------------------------------------------

function warnIfMissingFromNoProxy(v) {
  if (!v.defaultHost) return;
  const list = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.includes(v.defaultHost)) {
    console.warn(
      `[vendor-loader] WARN vendor "${v.id}" has noProxy:true but ` +
      `defaultHost "${v.defaultHost}" is NOT in NO_PROXY env. ` +
      `Outbound requests may go through HTTPS_PROXY and trip the ` +
      `gateway's anti-abuse IP-ban.`,
    );
  }
}
