import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeConfigLoader,
  createRuntimeConfigWatcher,
  parseDotenv,
} from '../src/config/runtime-config.mjs';

assert.deepEqual(parseDotenv('A=1\nB="two"\n# x\nC=three=four\n'), {
  A: '1', B: 'two', C: 'three=four',
});

const root = mkdtempSync(join(tmpdir(), 'mimo-runtime-config-'));
const paths = {
  envFile: join(root, '.env'),
  vendorsPath: join(root, 'vendors.json'),
  relaysPath: join(root, 'relays.json'),
  modelsPath: join(root, 'models.json'),
};

try {
  writeFileSync(paths.envFile, 'tomato_tap_relay_a_key=file-key\nOVERRIDE=file\n');
  writeFileSync(paths.vendorsPath, JSON.stringify({
    schemaVersion: 1,
    vendors: [{
      id: 'relay', envDiscovery: 'multi', envPrefix: '^tomato_tap_relay_(.+?)_key$',
      routes: [{ prefix: '/oa/v1', apiFormat: 'openai', auth: 'bearer' }],
    }],
  }));
  writeFileSync(paths.relaysPath, JSON.stringify({
    schemaVersion: 1,
    relays: { a: { host: 'example.test', path: '/v1', models: ['real-a'] } },
  }));
  writeFileSync(paths.modelsPath, JSON.stringify({
    schemaVersion: 1,
    realModels: {
      'real-a': {
        qualityTier: 'strong', capabilities: ['strict_json'], thinkingAdapter: 'none',
        maxInflight: 1, initialLatencyMs: 10, firstByteTimeoutMs: 10, totalTimeoutMs: 20,
      },
    },
    taskSubtypes: {
      'basic-default': {
        candidates: ['real-a'], requiredCapabilities: ['strict_json'],
        maxAttempts: 1, deadlineMs: 100,
      },
    },
    logicalModels: {
      basic: {
        candidates: ['real-a'], requiredCapabilities: ['strict_json'], allowedTaskSubtypes: ['basic-default'],
        maxInflight: 1, maxAttempts: 1, deadlineMs: 100,
      },
    },
  }));
  const loader = createRuntimeConfigLoader({
    functionRegistry: { auth: { bearer() {} } },
    processEnvOverrides: { OVERRIDE: 'process' },
    ...paths,
  });
  const initial = loader.load();
  assert.equal(initial.env.OVERRIDE, 'process');
  assert.equal(initial.env.tomato_tap_relay_a_key, 'file-key');
  assert.equal(initial.modelPolicy.logicalModels.has('basic'), true);
  assert.deepEqual(initial.configBackend, { requested: 'files', effective: 'files' });
  assert.equal(loader.load(), initial);

  const sqliteLoader = createRuntimeConfigLoader({
    functionRegistry: { auth: { bearer() {} } },
    processEnvOverrides: { TOMATO_TAP_CONFIG_BACKEND: 'sqlite', OVERRIDE: 'process' },
    sqliteSnapshotLoader: () => ({
      active: true,
      revision: 7,
      env: { tomato_tap_relay_a_key: 'sqlite-key', OVERRIDE: 'sqlite' },
      relays: JSON.parse(`{
        "schemaVersion": 1,
        "relays": {"a": {"host": "sqlite.example.test", "path": "/v1", "models": ["real-a"]}}
      }`),
      models: JSON.parse(readFileSync(paths.modelsPath, 'utf8')),
    }),
    registryPath: join(root, 'tomato-config.db'),
    ...paths,
  });
  const sqliteConfig = sqliteLoader.load();
  assert.deepEqual(sqliteConfig.configBackend, { requested: 'sqlite', effective: 'sqlite' });
  assert.equal(sqliteConfig.env.tomato_tap_relay_a_key, 'sqlite-key');
  assert.equal(sqliteConfig.env.OVERRIDE, 'process');
  assert.equal(sqliteConfig.relayRegistry.relays.a.host, 'sqlite.example.test');

  const unavailableSqlite = createRuntimeConfigLoader({
    functionRegistry: { auth: { bearer() {} } },
    processEnvOverrides: { TOMATO_TAP_CONFIG_BACKEND: 'sqlite' },
    sqliteSnapshotLoader: () => null,
    ...paths,
  });
  assert.throws(() => unavailableSqlite.load(), /requires an active SQLite configuration registry/);

  const candidates = [];
  const errors = [];
  const watcher = createRuntimeConfigWatcher({
    loader,
    initialRevision: initial.revision,
    onCandidate: async (candidate) => candidates.push(candidate),
    onError: (error) => errors.push(error),
  });
  assert.equal(await watcher.check(), false);
  writeFileSync(paths.envFile, 'tomato_tap_relay_a_key=rotated\nOVERRIDE=file\n');
  assert.equal(await watcher.check(), true);
  assert.equal(candidates.at(-1).env.tomato_tap_relay_a_key, 'rotated');
  assert.equal(candidates.at(-1).env.OVERRIDE, 'process');

  writeFileSync(paths.modelsPath, '{broken');
  assert.equal(await watcher.check(), false);
  assert.equal(errors.length, 1);
  assert.equal(await watcher.check(), false);
  assert.equal(errors.length, 1);
  assert.equal(watcher.status().revision, candidates.at(-1).revision);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('test_runtime_config: ok');
