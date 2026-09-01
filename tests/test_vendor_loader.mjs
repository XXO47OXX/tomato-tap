// Regression tests for vendor-loader.mjs.
//
// Run with: node test_vendor_loader.mjs
// Exits non-zero on any failure so CI / pre-commit can wire it up.

import { loadVendors, resolveUpstreamPath } from '../src/providers/vendor-loader.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';

const NOOP = () => () => {};
const stubReg = {
  auth:      { 'bearer': NOOP(), 'x-api-key': NOOP() },
  inject:    { 'injectReasoningSplit': NOOP(), 'injectChatToCodex': NOOP() },
  transform: { 'transformCodexToChat': NOOP() },
};

let failures = 0;

function expectThrow(label, configFn) {
  const tmp = `/tmp/_vl_${process.pid}_${Math.random()}.json`;
  writeFileSync(tmp, JSON.stringify(configFn()));
  try {
    loadVendors(stubReg, { path: tmp });
    console.error(`FAIL [${label}] should have thrown but did not`);
    failures++;
  } catch (e) {
    console.log(`pass [${label}]: ${e.message}`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function expectSuccess(label, configFn, assertion) {
  const tmp = `/tmp/_vl_${process.pid}_${Math.random()}.json`;
  writeFileSync(tmp, JSON.stringify(configFn()));
  try {
    const result = loadVendors(stubReg, { path: tmp });
    if (assertion(result)) {
      console.log(`pass [${label}]`);
    } else {
      console.error(`FAIL [${label}] assertion returned false`);
      failures++;
    }
  } catch (e) {
    console.error(`FAIL [${label}] threw unexpectedly: ${e.message}`);
    failures++;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

const base = (override = {}) => ({
  schemaVersion: 1,
  capPolicies: { 'static-low': { initial: 3, min: 3, max: 3 } },
  vendors: [{
    id: 'test', displayName: 'Test', envDiscovery: 'single',
    envPrefix: '^test_', defaultHost: 'host',
    routes: [{ prefix: '/t', apiFormat: 'openai', auth: 'bearer' }],
    ...override,
  }],
});

// --- Failure cases: every misuse must throw with a clear message -----------

expectThrow('bad schemaVersion',          () => ({ ...base(), schemaVersion: 99 }));
expectThrow('empty vendors',              () => ({ schemaVersion: 1, capPolicies: {}, vendors: [] }));
expectThrow('vendor missing id',          () => ({ schemaVersion: 1, capPolicies: {}, vendors: [{}] }));
expectThrow('unknown envDiscovery',       () => base({ envDiscovery: 'bogus' }));
expectThrow('dump_file w/o envDumpPath',  () => base({ envDiscovery: 'dump_file', envDumpPath: undefined, envPrefix: undefined }));
expectThrow('bad apiFormat',              () => base({ routes: [{ prefix: '/t', apiFormat: 'rest', auth: 'bearer' }] }));
expectThrow('unknown auth name',          () => base({ routes: [{ prefix: '/t', apiFormat: 'openai', auth: 'voodoo' }] }));
expectThrow('unknown capPolicyRef',       () => base({ capPolicyRef: 'nope' }));
expectThrow('openai_responses sans pair', () => base({ routes: [{ prefix: '/t', apiFormat: 'openai_responses', auth: 'bearer' }] }));
expectThrow('unknown injectBody',         () => base({ routes: [{ prefix: '/t', apiFormat: 'openai', auth: 'bearer', injectBody: 'mystery' }] }));
expectThrow('non-string upstreamPathPrefix', () => base({
  routes: [{ prefix: '/t', apiFormat: 'openai', auth: 'bearer', upstreamPathPrefix: 42 }],
}));
expectThrow('negative 429 recovery wait', () => base({
  retryPolicy: { waitFor429RecoveryMs: -1 },
}));
expectThrow('excessive 429 recovery wait', () => base({
  retryPolicy: { waitFor429RecoveryMs: 300001 },
}));
expectThrow('request timeout first byte exceeds total', () => base({
  requestTimeouts: { firstByteMs: 20_000, totalMs: 10_000 },
}));
expectThrow('invalid 401 cooldown override', () => base({
  auth401CooldownMs: -1,
}));
expectThrow('duplicate vendor id', () => ({
  schemaVersion: 1, capPolicies: {},
  vendors: [
    { id: 'x', envDiscovery: 'single', envPrefix: '^x_', defaultHost: 'h',
      routes: [{ prefix: '/a', apiFormat: 'openai', auth: 'bearer' }] },
    { id: 'x', envDiscovery: 'single', envPrefix: '^x2_', defaultHost: 'h',
      routes: [{ prefix: '/b', apiFormat: 'openai', auth: 'bearer' }] },
  ],
}));
expectThrow(
  'pricing billing timezone rejects invalid offsets',
  () => base({
    pricing: {
      currency: 'CNY', unit: 'million_tokens', billingUtcOffsetMinutes: 900,
      models: [{ match: 'model', inputCached: 0, inputMiss: 1, output: 2 }],
    },
  }),
);

// --- Happy paths: rewrites, defaults, cap inheritance ----------------------

expectSuccess(
  'identity rewrite when no rewrite spec',
  () => base(),
  ({ VENDORS }) => VENDORS.test.routes[0].rewrite('/t/anything') === '/t/anything',
);

expectSuccess(
  'rewrite from/to applied',
  () => base({ routes: [{ prefix: '/t', apiFormat: 'openai', auth: 'bearer',
                          rewrite: { from: '^/t', to: '/upstream' } }] }),
  ({ VENDORS }) => VENDORS.test.routes[0].rewrite('/t/foo') === '/upstream/foo',
);

expectSuccess(
  'route upstream path override shares a key without inheriting its protocol path',
  () => base({ routes: [{
    prefix: '/direct/v1/chat/completions', apiFormat: 'openai', auth: 'bearer',
    upstreamPathPrefix: '', rewrite: { from: '^/direct/v1', to: '/v1' },
  }] }),
  ({ VENDORS }) => resolveUpstreamPath(
    VENDORS.test.routes[0],
    { pathPrefix: '/anthropic' },
    '/direct/v1/chat/completions',
  ) === '/v1/chat/completions',
);

expectSuccess(
  'route without override keeps relay key upstream path',
  () => base({ routes: [{
    prefix: '/direct/v1/messages', apiFormat: 'anthropic', auth: 'bearer',
    rewrite: { from: '^/direct/v1/messages', to: '/v1/messages' },
  }] }),
  ({ VENDORS }) => resolveUpstreamPath(
    VENDORS.test.routes[0],
    { pathPrefix: '/anthropic' },
    '/direct/v1/messages',
  ) === '/anthropic/v1/messages',
);

expectSuccess(
  'no capPolicyRef and no vendorMaxInflight = no override entry',
  () => base(),
  ({ VENDOR_CAP_OVERRIDES }) => !('test' in VENDOR_CAP_OVERRIDES),
);

expectSuccess(
  'vendorMaxInflight alone produces override entry',
  () => base({ vendorMaxInflight: 7 }),
  ({ VENDOR_CAP_OVERRIDES }) => VENDOR_CAP_OVERRIDES.test?.vendorMaxInflight === 7,
);

expectSuccess(
  'capPolicyRef pulls policy fields',
  () => base({ capPolicyRef: 'static-low' }),
  ({ VENDOR_CAP_OVERRIDES }) => {
    const o = VENDOR_CAP_OVERRIDES.test;
    return o && o.initial === 3 && o.min === 3 && o.max === 3;
  },
);

expectSuccess(
  'preferHigherWeight is compiled for deterministic primary/fallback vendors',
  () => base({ preferHigherWeight: true }),
  ({ VENDORS }) => VENDORS.test.preferHigherWeight === true,
);

expectSuccess(
  'preserveIncomingBody is compiled for verbatim direct bridges',
  () => base({ preserveIncomingBody: true }),
  ({ VENDORS }) => VENDORS.test.preserveIncomingBody === true,
);

expectSuccess(
  'logical pool eligibility defaults on and supports dedicated bridge opt-out',
  () => ({
    schemaVersion: 1,
    vendors: [
      base().vendors[0],
      { ...base().vendors[0], id: 'direct', logicalEligible: false },
    ],
  }),
  ({ VENDORS }) => VENDORS.test.logicalEligible === true
    && VENDORS.direct.logicalEligible === false,
);

expectSuccess(
  'route retry policy compiles bounded 429 recovery waits',
  () => base({ retryPolicy: { waitFor429RecoveryMs: 35000 } }),
  ({ VENDORS }) => VENDORS.test.retryPolicy?.waitFor429RecoveryMs === 35000,
);

expectSuccess(
  'vendor request timeout policy compiles independently of global defaults',
  () => base({ requestTimeouts: { firstByteMs: 300_000, totalMs: 1_800_000 } }),
  ({ VENDORS }) => VENDORS.test.requestTimeouts?.firstByteMs === 300_000
    && VENDORS.test.requestTimeouts?.totalMs === 1_800_000,
);

expectSuccess(
  'vendor 401 cooldown override is explicit configuration',
  () => base({ auth401CooldownMs: 0 }),
  ({ VENDORS }) => VENDORS.test.auth401CooldownMs === 0,
);

expectSuccess(
  'pricing compiles weekend off-peak billing timezone',
  () => base({
    pricing: {
      currency: 'CNY', unit: 'million_tokens', peakMultiplier: 2,
      offPeakWeekends: true, billingUtcOffsetMinutes: 480,
      models: [{ match: 'model', inputCached: 0.02, inputMiss: 1, output: 2 }],
    },
  }),
  ({ VENDORS }) => VENDORS.test.pricing.offPeakWeekends === true
    && VENDORS.test.pricing.billingUtcOffsetMinutes === 480,
);

// --- Summary ---------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll vendor-loader tests passed.');
