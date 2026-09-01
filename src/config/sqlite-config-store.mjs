import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

export function createSqliteConfigStore({ path, now = () => Date.now() } = {}) {
  if (!path) throw new Error('sqlite-config: path is required');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tomato_config_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tomato_config_documents (
      name TEXT PRIMARY KEY CHECK(name IN ('env', 'relays', 'models')),
      document_json TEXT NOT NULL CHECK(json_valid(document_json)),
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO tomato_config_meta(
      singleton, schema_version, revision, active, updated_at
    ) VALUES (1, ${SCHEMA_VERSION}, 0, 0, 0);
  `);
  const meta = db.prepare(
    'SELECT schema_version FROM tomato_config_meta WHERE singleton=1',
  ).get();
  if (Number(meta?.schema_version) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`sqlite-config: unsupported schema version ${meta?.schema_version}`);
  }
  harden(path);

  const readDocument = db.prepare(
    'SELECT document_json FROM tomato_config_documents WHERE name=?',
  );
  const writeDocument = db.prepare(`
    INSERT INTO tomato_config_documents(name, document_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      document_json=excluded.document_json,
      updated_at=excluded.updated_at
  `);

  function snapshot({ includeInactive = false } = {}) {
    const state = db.prepare(
      'SELECT revision, active, updated_at FROM tomato_config_meta WHERE singleton=1',
    ).get();
    if (!state || (!includeInactive && !state.active)) return null;
    const documents = Object.fromEntries(['env', 'relays', 'models'].map((name) => {
      const row = readDocument.get(name);
      return [name, row ? parseDocument(name, row.document_json) : null];
    }));
    if (state.active && Object.values(documents).some((value) => value == null)) {
      throw new Error('sqlite-config: active registry is missing a required document');
    }
    return Object.freeze({
      active: Boolean(state.active),
      revision: Number(state.revision),
      updatedAt: Number(state.updated_at),
      env: documents.env || {},
      relays: documents.relays,
      models: documents.models,
      path,
    });
  }

  function replaceAll({ env = {}, relays, models } = {}) {
    validateDocuments({ env, relays, models });
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      writeDocument.run('env', JSON.stringify(env), timestamp);
      writeDocument.run('relays', JSON.stringify(relays), timestamp);
      writeDocument.run('models', JSON.stringify(models), timestamp);
      bumpRevision(timestamp, true);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    harden(path);
    return snapshot();
  }

  function writeNamed(name, document) {
    if (!['env', 'relays', 'models'].includes(name)) {
      throw new Error(`sqlite-config: unsupported document ${name}`);
    }
    const current = snapshot({ includeInactive: true });
    const next = {
      env: current?.env || {},
      relays: current?.relays,
      models: current?.models,
      [name]: document,
    };
    return replaceAll(next);
  }

  function updateEnv(changes) {
    const current = snapshot();
    if (!current) throw new Error('sqlite-config: registry is not active');
    const env = { ...current.env };
    for (const [name, value] of Object.entries(changes || {})) {
      if (value == null || value === '') delete env[name];
      else env[name] = String(value);
    }
    return writeNamed('env', env);
  }

  function bumpRevision(timestamp, active) {
    db.prepare(`
      UPDATE tomato_config_meta
      SET revision=revision + 1, active=?, updated_at=?
      WHERE singleton=1
    `).run(active ? 1 : 0, timestamp);
  }

  function close() {
    db.close();
  }

  return Object.freeze({ path, snapshot, replaceAll, writeNamed, updateEnv, close });
}

export function createSqliteOperatorRepository(store) {
  if (!store?.snapshot) throw new Error('sqlite operator repository requires a store');
  return Object.freeze({
    mode: 'sqlite',
    paths: Object.freeze({
      env: `${store.path}#env`,
      relays: `${store.path}#relays`,
      models: `${store.path}#models`,
    }),
    readEnv: () => ({ ...requiredSnapshot(store).env }),
    readRelays: () => structuredClone(requiredSnapshot(store).relays),
    readModels: () => structuredClone(requiredSnapshot(store).models),
    writeRelays: (value) => store.writeNamed('relays', value),
    writeModels: (value) => store.writeNamed('models', value),
    updateEnv: (changes) => store.updateEnv(changes),
    commit({ relays, models, envChanges = {} } = {}) {
      const current = requiredSnapshot(store);
      const env = applyEnvChanges(current.env, envChanges);
      return store.replaceAll({
        env,
        relays: relays || current.relays,
        models: models || current.models,
      });
    },
  });
}

function requiredSnapshot(store) {
  const value = store.snapshot();
  if (!value) throw new Error('sqlite-config: registry is not active');
  return value;
}

function applyEnvChanges(current, changes) {
  const env = { ...current };
  for (const [name, value] of Object.entries(changes || {})) {
    if (value == null || value === '') delete env[name];
    else env[name] = String(value);
  }
  return env;
}

function validateDocuments({ env, relays, models }) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('sqlite-config: env document must be an object');
  }
  if (!relays || typeof relays !== 'object' || Array.isArray(relays)) {
    throw new Error('sqlite-config: relays document must be an object');
  }
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error('sqlite-config: models document must be an object');
  }
}

function parseDocument(name, value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`sqlite-config: invalid ${name} document`);
  }
}

function harden(path) {
  if (existsSync(path)) chmodSync(path, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600);
  }
}
