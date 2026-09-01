#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDotenv } from '../src/config/runtime-config.mjs';
import { resolveStateLayout } from '../src/config/state-layout.mjs';
import { loadRelayRegistry } from '../src/providers/relay-loader.mjs';
import { loadModelPolicy } from '../src/routing/model-policy.mjs';
import {
  atomicWriteJson,
  ensureOperatorConfigFiles,
  updateEnvFile,
} from '../src/admin/private-config-files.mjs';
import { createSqliteConfigStore } from '../src/config/sqlite-config-store.mjs';

process.umask(0o077);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'status';
const envPath = resolve(args.env || process.env.TOMATO_TAP_ENV_FILE || join(root, '.env'));
const configDir = resolve(process.env.TOMATO_TAP_CONFIG_DIR || join(root, 'config', 'local'));
const paths = ensureOperatorConfigFiles({
  relaysPath: resolve(args.relays || process.env.TOMATO_TAP_RELAYS_PATH || join(configDir, 'relays.json')),
  modelsPath: resolve(args.models || process.env.TOMATO_TAP_MODELS_PATH || join(configDir, 'models.json')),
  seedRelaysPath: join(root, 'config', 'relays.json'),
  seedModelsPath: join(root, 'config', 'models.json'),
});
const state = resolveStateLayout(root, process.env);
const dbPath = resolve(args.db || process.env.TOMATO_TAP_CONFIG_DB_PATH
  || join(state.runtimeDir, 'tomato-config.db'));

if (command === 'status') status();
else if (command === 'import-files') importFiles();
else if (command === 'export-files') exportFiles();
else usage(1);

function status() {
  if (!existsSync(dbPath)) {
    print({ database: dbPath, active: false, backend: 'files' });
    return;
  }
  const store = createSqliteConfigStore({ path: dbPath });
  try {
    const snapshot = store.snapshot({ includeInactive: true });
    print(redactedSummary(snapshot));
  } finally {
    store.close();
  }
}

function importFiles() {
  const documents = readFileDocuments();
  validateDocuments(documents);
  if (!args.apply) {
    print({ dry_run: true, action: 'import-files', ...redactedSummary(documents) });
    return;
  }
  const store = createSqliteConfigStore({ path: dbPath });
  try {
    if (store.snapshot() && !args.force) {
      throw new Error('configuration database is already active; pass --force to replace it');
    }
    const snapshot = store.replaceAll(documents);
    updateEnvFile(envPath, { TOMATO_TAP_CONFIG_BACKEND: 'sqlite' });
    print({ applied: true, action: 'import-files', ...redactedSummary(snapshot) });
  } finally {
    store.close();
  }
}

function exportFiles() {
  if (!existsSync(dbPath)) throw new Error(`configuration database not found: ${dbPath}`);
  const store = createSqliteConfigStore({ path: dbPath });
  try {
    const snapshot = store.snapshot();
    if (!snapshot) throw new Error('configuration database is not active');
    validateDocuments(snapshot);
    if (!args.apply) {
      print({ dry_run: true, action: 'export-files', ...redactedSummary(snapshot) });
      return;
    }
    const backupDir = createBackup();
    atomicWriteJson(paths.relaysPath, snapshot.relays);
    atomicWriteJson(paths.modelsPath, snapshot.models);
    const currentEnv = parseDotenv(readOptional(envPath));
    const changes = {};
    for (const name of Object.keys(currentEnv)) {
      if (isManagedConfigName(name) && !Object.hasOwn(snapshot.env, name)) changes[name] = null;
    }
    Object.assign(changes, snapshot.env, { TOMATO_TAP_CONFIG_BACKEND: 'files' });
    updateEnvFile(envPath, changes);
    print({
      applied: true,
      action: 'export-files',
      backup: backupDir,
      ...redactedSummary(snapshot),
    });
  } finally {
    store.close();
  }
}

function readFileDocuments() {
  return {
    active: true,
    revision: 0,
    env: parseDotenv(readOptional(envPath)),
    relays: JSON.parse(readFileSync(paths.relaysPath, 'utf8')),
    models: JSON.parse(readFileSync(paths.modelsPath, 'utf8')),
  };
}

function validateDocuments(documents) {
  loadRelayRegistry({ path: paths.relaysPath, document: documents.relays });
  loadModelPolicy({ path: paths.modelsPath, document: documents.models });
}

function createBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(state.runtimeDir, 'backups', `config-files-${stamp}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const [name, path] of Object.entries({
    env: envPath,
    relays: paths.relaysPath,
    models: paths.modelsPath,
  })) {
    if (!existsSync(path)) continue;
    const destination = join(backupDir, name === 'env' ? '.env' : `${name}.json`);
    copyFileSync(path, destination);
    chmodSync(destination, 0o600);
  }
  return backupDir;
}

function redactedSummary(snapshot) {
  const env = snapshot?.env || {};
  const credentials = Object.keys(env).filter((name) => (
    /^tomato_tap_relay_.+_key$/i.test(name) || /^mimotap_relay_.+_key$/i.test(name)
  )).length;
  return {
    database: dbPath,
    active: Boolean(snapshot?.active),
    revision: Number(snapshot?.revision || 0),
    providers: Object.keys(snapshot?.relays?.relays || {}).length,
    real_models: Object.keys(snapshot?.models?.realModels || {}).length,
    logical_models: Object.keys(snapshot?.models?.logicalModels || {}).length,
    credentials,
  };
}

function isManagedConfigName(name) {
  return /^TOMATO_TAP_/i.test(name)
    || /^tomato_tap_relay_/i.test(name)
    || /^mimotap_relay_/i.test(name);
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(tokens) {
  const parsed = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (['apply', 'force'].includes(name)) parsed[name] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) usage(1);
      parsed[name] = value;
      index += 1;
    }
  }
  return parsed;
}

function usage(exitCode = 0) {
  process.stderr.write(`Usage:
  node scripts/config-storage.mjs status [--db PATH]
  node scripts/config-storage.mjs import-files [--apply] [--force] [--db PATH]
  node scripts/config-storage.mjs export-files [--apply] [--db PATH]
`);
  process.exit(exitCode);
}
