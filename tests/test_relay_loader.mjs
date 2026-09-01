// Regression tests for relay-loader.mjs.
//
// Run with: node tests/test_relay_loader.mjs

import assert from 'node:assert/strict';
import {
  loadRelayRegistry,
  discoverRelayKeys,
  normalizeProxyPolicy,
  normalizeQuotaPolicy,
  normalizeExpiresAt,
  normalizeApiFormats,
  normalizeRequestPolicy,
  normalizeRateLimitPolicy,
  normalizeCanonicalModels,
  normalizeAuthType,
} from '../src/providers/relay-loader.mjs';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

let failures = 0;

function withJson(config, fn) {
  const tmp = `/tmp/_rl_${process.pid}_${Math.random()}.json`;
  writeFileSync(tmp, JSON.stringify(config));
  try {
    return fn(tmp);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function expectSuccess(label, fn) {
  try {
    if (fn()) {
      console.log(`pass [${label}]`);
    } else {
      console.error(`FAIL [${label}] assertion returned false`);
      failures++;
    }
  } catch (e) {
    console.error(`FAIL [${label}] threw unexpectedly: ${e.message}`);
    failures++;
  }
}

function expectThrow(label, fn) {
  try {
    fn();
    console.error(`FAIL [${label}] should have thrown but did not`);
    failures++;
  } catch (e) {
    console.log(`pass [${label}]: ${e.message}`);
  }
}

expectSuccess('loads relay metadata from json and secrets from env', () => withJson({
  schemaVersion: 1,
  relays: {
    alpha: {
      provider: 'provider-a',
      host: 'api.example.test',
      path: '/v1',
      models: ['deepseek-v4-flash', 'upstream'],
      proto: 'http',
      port: 18888,
      cap: { initial: 1, min: 1, max: 2 },
      aliases: { client: 'upstream' },
      apiFormats: ['openai'],
      auth: 'x-api-key',
      request: { reasoningEffort: 'none' },
      rateLimit: { requestsPerMinute: 60, mode: 'paced' },
      headers: {
        'x-client-type': 'cli',
      },
      proxy: true,
      weight: 3,
      quota: {
        initialState: 'closed',
        probeModel: 'deepseek-v4-flash',
        probeIntervalMs: 300000,
        boostWindowMs: 18000000,
        boostWeight: 4,
        probeMaxTokens: 256,
      },
      expiresAt: '2026-08-06T16:37:53+08:00',
    },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const keys = discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_alpha_key: 'sk-test',
  }, registry);
  const k = keys[0];
  return keys.length === 1
    && k.deploymentId === 'alpha'
    && !k.deploymentId.includes(k.value)
    && k.name === 'tomato_tap_relay_alpha'
    && k.providerLabel === 'provider-a'
    && k.value === 'sk-test'
    && k.host === 'api.example.test'
    && k.pathPrefix === '/v1'
    && k.proto === 'http'
    && k.port === 18888
    && k.modelSet.has('deepseek-v4-flash')
    && k.modelSet.has('upstream')
    && k.modelSet.has('client')
    && k.upstreamModelSet.has('upstream')
    && !k.upstreamModelSet.has('client')
    && k.canonicalModelSet.has('deepseek-v4-flash')
    && k.canonicalModelSet.has('client')
    && !k.canonicalModelSet.has('upstream')
    && k.capInitial === 1
    && k.capMin === 1
    && k.capMax === 2
    && k.modelAliases.get('client') === 'upstream'
    && k.apiFormats.size === 1
    && k.apiFormats.has('openai')
    && k.authType === 'x-api-key'
    && k.requestPolicy.reasoningEffort === 'none'
    && k.rateLimitPolicy.requestsPerMinute === 60
    && k.rateLimitPolicy.mode === 'paced'
    && k.baseWeight === 3
    && k.quotaPolicy.initialState === 'closed'
    && k.quotaPolicy.probeModel === 'deepseek-v4-flash'
    && k.quotaPolicy.probeIntervalMs === 300000
    && k.quotaPolicy.boostWindowMs === 18000000
    && k.quotaPolicy.boostWeight === 4
    && k.quotaPolicy.probeMaxTokens === 256
    && k.expiresAtMs === Date.parse('2026-08-06T16:37:53+08:00')
    && k.useProxy === true;
}));

expectSuccess('accepts legacy relay credentials and prefers canonical duplicates', () => withJson({
  schemaVersion: 1,
  relays: {
    alpha: { host: 'api.example.test', models: ['model-a'] },
    legacy: { host: 'api.example.test', models: ['model-b'] },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const keys = discoverRelayKeys(
    'relay',
    /^(?:tomato_tap|mimotap)_relay_(.+?)_key$/i,
    {
      mimotap_relay_alpha_key: 'shadowed',
      tomato_tap_relay_alpha_key: 'canonical',
      mimotap_relay_legacy_key: 'legacy-only',
    },
    registry,
  );
  return keys.length === 2
    && keys.find((key) => key.deploymentId === 'alpha')?.value === 'canonical'
    && keys.find((key) => key.deploymentId === 'legacy')?.name === 'tomato_tap_relay_legacy';
}));

expectThrow('rejects invalid provider label', () => withJson({
  schemaVersion: 1,
  relays: {
    invalid: {
      provider: '',
      host: 'api.example.test',
      models: ['model'],
    },
  },
}, (path) => loadRelayRegistry({ path })));

expectSuccess('passes relay headers into discovered key metadata', () => withJson({
  schemaVersion: 1,
  relays: {
    headered: {
      host: 'api.example.test',
      path: '/v1',
      models: ['deepseek-v4-flash'],
      headers: {
        'x-client-type': 'cli',
      },
    },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const keys = discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_headered_key: 'sk-test',
  }, registry);
  const k = keys[0];
  return k.headers && k.headers['x-client-type'] === 'cli';
}));

expectSuccess('normalizes relay expiry', () =>
  normalizeExpiresAt('temporary', '2026-08-06T16:37:53+08:00')
    === Date.parse('2026-08-06T16:37:53+08:00'));
expectThrow('rejects invalid relay expiry', () =>
  normalizeExpiresAt('temporary', 'not-a-date'));

expectSuccess('disabled relay is skipped', () => withJson({
  schemaVersion: 1,
  relays: {
    dead: { disabled: true, host: 'api.example.test', path: '/v1', models: ['x'] },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const keys = discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_dead_key: 'sk-test',
  }, registry);
  return keys.length === 0;
}));

expectThrow('missing relay metadata for key', () => withJson({
  schemaVersion: 1,
  relays: {},
}, (path) => {
  const registry = loadRelayRegistry({ path });
  discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_missing_key: 'sk-test',
  }, registry);
}));

expectThrow('invalid cap value', () => withJson({
  schemaVersion: 1,
  relays: {
    badcap: { host: 'api.example.test', path: '/v1', models: ['x'], cap: { initial: 0 } },
  },
}, (path) => loadRelayRegistry({ path })));

expectSuccess('normalizes backward-compatible proxy policies', () => {
  const direct = normalizeProxyPolicy('direct', undefined);
  const disabled = normalizeProxyPolicy('disabled', false);
  const shared = normalizeProxyPolicy('shared', true);
  const automatic = normalizeProxyPolicy('automatic', { mode: 'sticky-auto' });
  const sticky = normalizeProxyPolicy('sticky', { mode: 'sticky', node: 'node-a' });
  return direct.mode === 'direct'
    && disabled.mode === 'direct'
    && shared.mode === 'shared'
    && automatic.mode === 'sticky-auto'
    && automatic.nodeId === null
    && sticky.mode === 'sticky'
    && sticky.nodeId === 'node-a';
});

expectThrow('rejects invalid sticky proxy without node', () =>
  normalizeProxyPolicy('bad', { mode: 'sticky' }));
expectThrow('rejects raw proxy URL in relay policy', () =>
  normalizeProxyPolicy('bad', { mode: 'sticky-auto', url: 'http://secret.example' }));

expectSuccess('derives canonical models while hiding aliased upstream names', () => {
  const aliases = new Map([
    ['deepseek-v4-flash', 'deepseek-v4-flash:0731'],
    ['qwen3.5', 'qwen3.5:397b'],
  ]);
  return JSON.stringify(normalizeCanonicalModels('pool', [
    'deepseek-v4-flash:0731',
    'qwen3.5:397b',
    'glm-5.2',
  ], aliases)) === JSON.stringify(['deepseek-v4-flash', 'qwen3.5', 'glm-5.2']);
});
expectSuccess('explicit canonical models keep compatibility aliases out of the pool', () => {
  const aliases = new Map([
    ['gpt-oss-120b', 'gpt-oss:120b'],
    ['openai/gpt-oss-120b', 'gpt-oss:120b'],
  ]);
  return JSON.stringify(normalizeCanonicalModels(
    'pool',
    ['gpt-oss:120b'],
    aliases,
    ['gpt-oss-120b'],
  )) === JSON.stringify(['gpt-oss-120b']);
});
expectThrow('rejects undeclared canonical model mapping', () =>
  normalizeCanonicalModels('bad', ['glm-5.2'], null, ['qwen3.5']));
expectThrow('rejects alias target missing from upstream models', () =>
  normalizeCanonicalModels('bad', ['glm-5.2'], new Map([['qwen3.5', 'qwen3.5:397b']])));

expectSuccess('defaults relay API formats for backward compatibility', () => {
  const formats = normalizeApiFormats('legacy', undefined);
  return formats.has('openai') && formats.has('anthropic') && formats.size === 2;
});
expectThrow('rejects unsupported relay API format', () =>
  normalizeApiFormats('bad', ['responses']));
expectSuccess('normalizes per-relay authentication', () =>
  normalizeAuthType('x', 'x-api-key') === 'x-api-key'
  && normalizeAuthType('x', 'bearer') === 'bearer');
expectThrow('rejects unsupported per-relay authentication', () =>
  normalizeAuthType('bad', 'basic'));
expectSuccess('normalizes relay request policy', () =>
  normalizeRequestPolicy('ollama', { reasoningEffort: 'NONE' }).reasoningEffort === 'none');
expectSuccess('normalizes relay output token cap', () =>
  normalizeRequestPolicy('policy', { maxOutputTokens: 49152 }).maxOutputTokens === 49152);
expectThrow('rejects unknown relay request policy field', () =>
  normalizeRequestPolicy('bad', { reasoningEffort: 'none', typo: true }));
expectSuccess('normalizes per-key request rate limit', () => {
  const policy = normalizeRateLimitPolicy('paced', { requestsPerMinute: 60, mode: 'paced' });
  return policy.requestsPerMinute === 60 && policy.mode === 'paced';
});
expectThrow('rejects invalid per-key request rate limit', () =>
  normalizeRateLimitPolicy('bad', { requestsPerMinute: 0, mode: 'paced' }));
expectThrow('rejects unknown per-key request rate limit mode', () =>
  normalizeRateLimitPolicy('bad', { requestsPerMinute: 60, mode: 'burst' }));

expectSuccess('missing quota policy normalizes to null', () =>
  normalizeQuotaPolicy('plain', undefined) === null);

for (const [label, quota] of [
  ['unknown quota field', {
    initialState: 'open', probeModel: 'x', probeIntervalMs: 1,
    boostWindowMs: 1, boostWeight: 1, probeMaxTokens: 1, typo: true,
  }],
  ['invalid initial state', {
    initialState: 'half_open', probeModel: 'x', probeIntervalMs: 1,
    boostWindowMs: 1, boostWeight: 1, probeMaxTokens: 1,
  }],
  ['missing probe model', {
    initialState: 'open', probeIntervalMs: 1,
    boostWindowMs: 1, boostWeight: 1, probeMaxTokens: 1,
  }],
  ['invalid probe interval', {
    initialState: 'open', probeModel: 'x', probeIntervalMs: 0,
    boostWindowMs: 1, boostWeight: 1, probeMaxTokens: 1,
  }],
  ['invalid boost window', {
    initialState: 'open', probeModel: 'x', probeIntervalMs: 1,
    boostWindowMs: 1.5, boostWeight: 1, probeMaxTokens: 1,
  }],
  ['invalid boost weight', {
    initialState: 'open', probeModel: 'x', probeIntervalMs: 1,
    boostWindowMs: 1, boostWeight: 0, probeMaxTokens: 1,
  }],
  ['invalid probe token limit', {
    initialState: 'open', probeModel: 'x', probeIntervalMs: 1,
    boostWindowMs: 1, boostWeight: 1, probeMaxTokens: -1,
  }],
]) {
  expectThrow(label, () => normalizeQuotaPolicy('bad', quota));
}

expectSuccess('discovered key exposes normalized sticky policy', () => withJson({
  schemaVersion: 1,
  relays: {
    sticky: {
      host: 'api.example.test', path: '/v1', models: ['x'],
      proxy: { mode: 'sticky', node: 'node-a' },
    },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const [key] = discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_sticky_key: 'sk-test',
  }, registry);
  return key.proxyPolicy.mode === 'sticky'
    && key.proxyPolicy.nodeId === 'node-a'
    && key.useProxy === false;
}));

expectSuccess('discovers a fixed per-key proxy from the secret env namespace', () => withJson({
  schemaVersion: 1,
  relays: {
    fixed: { host: 'api.example.test', path: '/v1', models: ['x'] },
  },
}, (path) => {
  const registry = loadRelayRegistry({ path });
  const [key] = discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
    tomato_tap_relay_fixed_key: 'sk-test',
    tomato_tap_relay_fixed_proxy_url: 'http://127.0.0.1:7890',
  }, registry);
  return key.proxyUrl === 'http://127.0.0.1:7890/'
    && key.proxyMode === 'fixed-http'
    && key.useProxy === false;
}));

expectThrow('rejects credentials in a fixed per-key proxy URL', () => withJson({
  schemaVersion: 1,
  relays: {
    fixed: { host: 'api.example.test', path: '/v1', models: ['x'] },
  },
}, (path) => discoverRelayKeys('relay', /^tomato_tap_relay_(.+?)_key$/i, {
  tomato_tap_relay_fixed_key: 'sk-test',
  tomato_tap_relay_fixed_proxy_url: 'http://user:secret@127.0.0.1:7890',
}, loadRelayRegistry({ path }))));

const starterRelays = JSON.parse(
  readFileSync(new URL("../config/relays.json", import.meta.url), "utf8"),
).relays;
assert.deepEqual(Object.keys(starterRelays), ["example"]);
assert.equal(starterRelays.example.host, "api.example.com");
assert.equal(starterRelays.example.path, "/v1");
assert.equal(starterRelays.example.disabled, true);
assert.deepEqual(starterRelays.example.models, ["example-model"]);
assert.deepEqual(starterRelays.example.canonicalModels, ["example-model"]);
const compiledStarterRelays = loadRelayRegistry().relays;
assert.equal(compiledStarterRelays.example.disabled, true);
assert.deepEqual(compiledStarterRelays.example.canonicalModels, ["example-model"]);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll relay-loader tests passed.');
