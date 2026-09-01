import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOperatorConfigStore,
  ensureOperatorConfigFiles,
} from '../src/admin/operator-config-store.mjs';

function starterDocuments(root) {
  const seed = join(root, 'seed');
  mkdirSync(seed);
  const relaySeed = join(seed, 'relays.json');
  const modelSeed = join(seed, 'models.json');
  writeFileSync(relaySeed, JSON.stringify({
    schemaVersion: 1,
    relays: {
      example: {
        disabled: true,
        host: 'api.example.com',
        path: '/v1',
        models: ['example-model'],
        canonicalModels: ['example-model'],
      },
    },
  }));
  writeFileSync(modelSeed, JSON.stringify({
    schemaVersion: 1,
    realModels: {
      'example-model': {
        qualityTier: 'standard',
        capabilities: ['instruction_following'],
        thinkingAdapter: 'none',
        maxInflight: 1,
        initialLatencyMs: 1000,
        firstByteTimeoutMs: 30000,
        totalTimeoutMs: 120000,
      },
    },
    taskSubtypes: {},
    logicalModels: {
      balanced: {
        requiredCapabilities: ['instruction_following'],
        candidates: ['example-model'],
        maxInflight: 1,
        maxAttempts: 1,
        deadlineMs: 60000,
      },
    },
  }));
  return { relaySeed, modelSeed };
}

test('operator store seeds private files and never returns credential material', () => {
  const root = mkdtempSync(join(tmpdir(), 'tomato-operator-'));
  try {
    const envPath = join(root, '.env');
    const relaysPath = join(root, 'config', 'local', 'relays.json');
    const modelsPath = join(root, 'config', 'local', 'models.json');
    const seed = starterDocuments(root);
    ensureOperatorConfigFiles({ relaysPath, modelsPath, seedRelaysPath: seed.relaySeed, seedModelsPath: seed.modelSeed });
    assert.equal(statSync(relaysPath).mode & 0o777, 0o600);
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);

    const store = createOperatorConfigStore({ envPath, relaysPath, modelsPath });
    assert.equal(store.snapshot().configured, false);
    const saved = store.upsertProvider({
      id: 'provider-a',
      label: 'Provider A',
      baseUrl: 'https://api.example.test/v1',
      apiFormat: 'openai',
      auth: 'bearer',
      apiKey: 'credential-value-one',
      models: ['model-a'],
      userAgent: 'supported-client/1.0',
      logicalModel: 'balanced',
      cap: { min: 1, initial: 2, max: 4 },
      requestsPerMinute: 60,
    });
    assert.equal(saved.configured, true);
    assert.equal(saved.providers.length, 1);
    assert.equal(saved.providers[0].credential.configured, true);
    assert.equal(saved.providers[0].credential.source, 'file');
    assert.equal(JSON.stringify(saved).includes('credential-value-one'), false);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.match(readFileSync(envPath, 'utf8'), /tomato_tap_relay_provider-a_key=credential-value-one/);

    const relays = JSON.parse(readFileSync(relaysPath, 'utf8'));
    assert.equal(relays.relays['provider-a'].host, 'api.example.test');
    assert.equal(relays.relays['provider-a'].headers['User-Agent'], 'supported-client/1.0');
    assert.equal(relays.relays['provider-a'].auth, 'bearer');
    assert.deepEqual(relays.relays['provider-a'].cap, { min: 1, initial: 2, max: 4 });
    const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
    assert.ok(models.realModels['model-a']);
    assert.deepEqual(models.logicalModels.balanced.candidates, ['model-a']);

    const tuned = store.upsertRealModel({
      name: 'model-a',
      qualityTier: 'strong',
      capabilities: ['instruction_following', 'strict_json'],
      thinkingAdapter: 'none',
      maxInflight: 3,
      maxTokensMultiplier: 1.5,
      initialLatencyMs: 800,
      firstByteTimeoutMs: 45000,
      totalTimeoutMs: 180000,
    });
    assert.equal(tuned.realModels[0].qualityTier, 'strong');
    assert.equal(tuned.realModels[0].maxInflight, 3);
    assert.deepEqual(tuned.realModels[0].capabilities, ['instruction_following', 'strict_json']);

    store.upsertLogicalModel({
      name: 'balanced',
      candidates: ['model-a'],
      requiredCapabilities: ['instruction_following'],
      qualityTier: 'strong',
      candidateStrategy: 'adaptive',
      maxInflight: 6,
      maxAttempts: 3,
      deadlineMs: 120000,
      logicalAdmissionWaitMs: 5000,
      sessionAffinity: true,
      preferDifferentFromPrevious: true,
      allowWeakFallback: false,
      protected: true,
      minReadySlots: 2,
      request: {
        reasoningEffort: 'low',
        temperature: 0,
        stream: false,
        maxOutputTokens: 2048,
      },
    });

    store.upsertProvider({
      id: 'provider-a', label: 'Provider A', baseUrl: 'https://api.example.test/v1',
      apiFormat: 'openai', auth: 'bearer', apiKey: 'credential-value-two',
      models: ['model-a'], logicalModel: 'balanced', cap: { min: 1, initial: 1, max: 2 },
    });
    const env = readFileSync(envPath, 'utf8');
    assert.equal((env.match(/tomato_tap_relay_provider-a_key=/g) || []).length, 1);
    assert.match(env, /credential-value-two/);
    assert.doesNotMatch(env, /credential-value-one/);
    const logical = JSON.parse(readFileSync(modelsPath, 'utf8')).logicalModels.balanced;
    assert.equal(logical.candidateStrategy, 'adaptive');
    assert.equal(logical.qualityTier, 'strong');
    assert.equal(logical.sessionAffinity, true);
    assert.equal(logical.allowWeakFallback, false);
    assert.equal(logical.protected, true);
    assert.equal(logical.minReadySlots, 2);
    assert.deepEqual(logical.request, {
      reasoningEffort: 'low',
      temperature: 0,
      stream: false,
      maxOutputTokens: 2048,
    });

    const fixedProxy = store.upsertProvider({
      id: 'provider-a', label: 'Provider A', baseUrl: 'https://api.example.test/v1',
      apiFormat: 'openai', auth: 'bearer', models: ['model-a'],
      proxy: { mode: 'fixed-http' }, fixedProxyUrl: 'http://127.0.0.1:8899',
      cap: { min: 1, initial: 1, max: 2 },
    });
    assert.equal(fixedProxy.providers[0].proxy.mode, 'fixed-http');
    assert.equal(fixedProxy.providers[0].fixedProxy.configured, true);
    assert.match(readFileSync(envPath, 'utf8'), /tomato_tap_relay_provider-a_proxy_url=http:\/\/127\.0\.0\.1:8899\//);
    const directAgain = store.upsertProvider({
      id: 'provider-a', label: 'Provider A', baseUrl: 'https://api.example.test/v1',
      apiFormat: 'openai', auth: 'bearer', models: ['model-a'], proxy: false,
      cap: { min: 1, initial: 1, max: 2 },
    });
    assert.equal(directAgain.providers[0].proxy, false);
    assert.doesNotMatch(readFileSync(envPath, 'utf8'), /tomato_tap_relay_provider-a_proxy_url=/);

    store.updateSettings({
      TOMATO_TAP_SAMPLES_ENABLED: 'false',
      TOMATO_TAP_SAMPLES_RETENTION: '24h',
    });
    assert.match(readFileSync(envPath, 'utf8'), /TOMATO_TAP_SAMPLES_RETENTION=24h/);

    const egress = store.updateEgress({
      subscriptionUrls: 'https://proxy.example.test/private-a\nhttps://proxy.example.test/private-b',
      staticNodes: 'vless://00000000-0000-4000-8000-000000000000@example.com:443?type=tcp',
      sharedProxyUrl: 'http://127.0.0.1:7890',
    });
    const egressEnv = readFileSync(envPath, 'utf8');
    assert.match(egressEnv, /TOMATO_TAP_PROXY_SUBSCRIPTION_URLS=https:\/\/proxy\.example\.test\/private-a,https:\/\/proxy\.example\.test\/private-b/);
    assert.match(egressEnv, /TOMATO_TAP_SHARED_PROXY_URL=http:\/\/127\.0\.0\.1:7890\//);
    assert.doesNotMatch(egressEnv, /vless:\/\//);
    assert.equal(egress.egress.subscriptions.count, 2);
    assert.equal(egress.egress.staticNodes.configured, true);
    assert.equal(JSON.stringify(egress).includes('00000000-0000-4000-8000-000000000000'), false);

    store.upsertProvider({
      id: 'provider-a', label: 'Provider A', baseUrl: 'https://api.example.test/v1',
      apiFormat: 'openai', auth: 'bearer', apiKey: 'credential-value-three',
      models: ['model-a'], proxy: { mode: 'fixed-http' },
      fixedProxyUrl: 'http://127.0.0.1:8899', cap: { min: 1, initial: 1, max: 2 },
    });
    store.removeProvider('provider-a');
    const cleanedEnv = readFileSync(envPath, 'utf8');
    assert.doesNotMatch(cleanedEnv, /tomato_tap_relay_provider-a_key=/);
    assert.doesNotMatch(cleanedEnv, /mimotap_relay_provider-a_key=/);
    assert.doesNotMatch(cleanedEnv, /tomato_tap_relay_provider-a_proxy_url=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing and appending a key preserve canonical model mappings', () => {
  const root = mkdtempSync(join(tmpdir(), 'tomato-operator-'));
  try {
    const envPath = join(root, '.env');
    const relaysPath = join(root, 'config', 'local', 'relays.json');
    const modelsPath = join(root, 'config', 'local', 'models.json');
    const seed = starterDocuments(root);
    ensureOperatorConfigFiles({ relaysPath, modelsPath, seedRelaysPath: seed.relaySeed, seedModelsPath: seed.modelSeed });
    writeFileSync(relaysPath, JSON.stringify({
      schemaVersion: 1,
      relays: {
        source: {
          provider: 'Source', host: 'api.example.test', proto: 'https', port: 443, path: '/v1',
          models: ['upstream-model'], aliases: { 'stable-model': 'upstream-model' },
          canonicalModels: ['stable-model'], apiFormats: ['openai'], auth: 'bearer',
          headers: { 'X-Channel': 'source-policy' }, cap: { min: 1, initial: 1, max: 4 },
        },
      },
    }));
    writeFileSync(modelsPath, JSON.stringify({
      schemaVersion: 1,
      realModels: {
        'stable-model': {
          qualityTier: 'standard', capabilities: ['instruction_following'],
          thinkingAdapter: 'none', maxInflight: 4, initialLatencyMs: 1500,
          firstByteTimeoutMs: 120000, totalTimeoutMs: 600000,
        },
      },
      taskSubtypes: {},
      logicalModels: {
        balanced: {
          requiredCapabilities: ['instruction_following'], candidates: ['stable-model'],
          candidateStrategy: 'fair', maxInflight: 4, maxAttempts: 2,
          deadlineMs: 60000, logicalAdmissionWaitMs: 1000,
        },
      },
    }));

    const store = createOperatorConfigStore({ envPath, relaysPath, modelsPath });
    store.upsertProvider({
      id: 'source', label: 'Source', baseUrl: 'https://api.example.test/v1',
      models: ['upstream-model'], cap: { min: 1, initial: 1, max: 4 },
    });
    store.upsertProvider({
      id: 'source-key-02', templateProviderId: 'source', label: 'Source',
      baseUrl: 'https://api.example.test/v1', models: ['upstream-model'],
      cap: { min: 1, initial: 1, max: 4 },
    });

    const relays = JSON.parse(readFileSync(relaysPath, 'utf8')).relays;
    assert.deepEqual(relays.source.aliases, { 'stable-model': 'upstream-model' });
    assert.deepEqual(relays.source.canonicalModels, ['stable-model']);
    assert.deepEqual(relays['source-key-02'].aliases, { 'stable-model': 'upstream-model' });
    assert.deepEqual(relays['source-key-02'].canonicalModels, ['stable-model']);
    assert.equal(relays['source-key-02'].headers['X-Channel'], 'source-policy');
    const models = JSON.parse(readFileSync(modelsPath, 'utf8')).realModels;
    assert.ok(models['stable-model']);
    assert.equal(Object.hasOwn(models, 'upstream-model'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('process credentials remain write-protected and validation fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tomato-operator-'));
  try {
    const envPath = join(root, '.env');
    const relaysPath = join(root, 'relays.json');
    const modelsPath = join(root, 'models.json');
    const seed = starterDocuments(root);
    ensureOperatorConfigFiles({ relaysPath, modelsPath, seedRelaysPath: seed.relaySeed, seedModelsPath: seed.modelSeed });
    const store = createOperatorConfigStore({
      envPath,
      relaysPath,
      modelsPath,
      processEnvOverrides: {
        'tomato_tap_relay_example_key': 'inherited-secret',
        HTTPS_PROXY: 'http://127.0.0.1:3128',
      },
    });
    const provider = store.snapshot().providers[0];
    assert.deepEqual(provider.credential, { configured: true, source: 'process', writable: false });
    assert.equal(JSON.stringify(provider).includes('inherited-secret'), false);
    assert.deepEqual(store.snapshot().egress.sharedProxy, {
      configured: true, source: 'network-env', writable: true, fallback: true,
    });
    assert.equal(JSON.stringify(store.snapshot()).includes('127.0.0.1:3128'), false);
    assert.throws(() => store.upsertProvider({
      id: 'example', label: 'Example', baseUrl: 'https://api.example.test/v1',
      models: ['example-model'], apiKey: 'shadow-secret',
    }), /process environment/);
    assert.throws(() => store.removeProvider('example'), /process-managed secrets/);
    assert.throws(() => store.upsertProvider({
      id: 'bad', label: 'Bad', baseUrl: 'file:///tmp/model', models: ['x'],
    }), /http\(s\)/);
    assert.throws(() => store.upsertProvider({
      id: 'bad', label: 'Bad', baseUrl: 'https://api.example.test/v1', models: ['x'],
      cap: { min: 4, initial: 2, max: 1 },
    }), /min <= initial <= max/);
    assert.throws(() => store.upsertLogicalModel({
      name: 'balanced', candidates: ['example-model'],
      requiredCapabilities: ['instruction_following'], sessionAffinity: 'yes',
    }), /sessionAffinity must be boolean/);
    assert.equal(JSON.parse(readFileSync(relaysPath, 'utf8')).relays.example.disabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
