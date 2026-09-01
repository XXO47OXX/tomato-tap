import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOperatorConfigStore } from '../src/admin/operator-config-store.mjs';

let sqliteModule;
try {
  sqliteModule = await import('../src/config/sqlite-config-store.mjs');
} catch (error) {
  if (error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(String(error?.message || ''))) {
    console.log('test_sqlite_config_store: skipped (requires Node.js 22.5+)');
    process.exit(0);
  }
  throw error;
}
const { createSqliteConfigStore, createSqliteOperatorRepository } = sqliteModule;

const root = mkdtempSync(join(tmpdir(), 'tomato-sqlite-config-'));
const path = join(root, 'registry.db');

try {
  const store = createSqliteConfigStore({ path, now: () => 1_000 });
  assert.equal(store.snapshot(), null);
  const initial = store.replaceAll({
    env: { tomato_tap_relay_a_key: 'secret-a' },
    relays: {
      schemaVersion: 1,
      relays: {
        example: {
          disabled: true,
          host: 'example.test',
          path: '/v1',
          models: ['example-model'],
          canonicalModels: ['example-model'],
        },
      },
    },
    models: {
      schemaVersion: 1,
      realModels: {
        'example-model': {
          qualityTier: 'standard',
          capabilities: ['instruction_following'],
          thinkingAdapter: 'none',
          maxInflight: 1,
          initialLatencyMs: 1_000,
          firstByteTimeoutMs: 30_000,
          totalTimeoutMs: 120_000,
        },
      },
      taskSubtypes: {},
      logicalModels: {
        balanced: {
          requiredCapabilities: ['instruction_following'],
          candidates: ['example-model'],
          maxInflight: 1,
          maxAttempts: 1,
          deadlineMs: 60_000,
        },
      },
    },
  });
  assert.equal(initial.active, true);
  assert.equal(initial.revision, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  const repository = createSqliteOperatorRepository(store);
  assert.equal(repository.mode, 'sqlite');
  repository.updateEnv({ tomato_tap_relay_a_key: 'secret-b', REMOVE: null });
  repository.writeRelays({ schemaVersion: 1, relays: { b: { host: 'b.example.test' } } });
  assert.equal(repository.readEnv().tomato_tap_relay_a_key, 'secret-b');
  assert.equal(repository.readRelays().relays.b.host, 'b.example.test');
  assert.equal(store.snapshot().revision, 3);

  store.replaceAll(initial);
  const operator = createOperatorConfigStore({
    envPath: join(root, '.env'),
    relaysPath: join(root, 'relays.json'),
    modelsPath: join(root, 'models.json'),
    repository,
  });
  const configured = operator.upsertProvider({
    id: 'provider-a',
    label: 'Provider A',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'private-secret',
    models: ['model-a'],
    logicalModel: 'balanced',
  });
  assert.equal(configured.storage, 'sqlite');
  assert.equal(configured.providers[0].credential.source, 'sqlite');
  assert.equal(JSON.stringify(configured).includes('private-secret'), false);
  assert.equal(store.snapshot().env['tomato_tap_relay_provider-a_key'], 'private-secret');
  store.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('test_sqlite_config_store: ok');
