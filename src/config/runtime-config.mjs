import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendors } from '../providers/vendor-loader.mjs';
import { loadRelayRegistry } from '../providers/relay-loader.mjs';
import { loadModelPolicy } from '../routing/model-policy.mjs';
import { loadTimeRoutePolicy } from '../routing/time-route-scheduler.mjs';
import { applyLegacyEnvAliases } from './env-compat.mjs';
import { normalizeConfigBackend, selectConfigBackend } from './config-backend.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseDotenv(text) {
  const output = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name) output[name] = value;
  }
  return output;
}

export function createRuntimeConfigLoader({
  functionRegistry,
  processEnvOverrides = {},
  envFile,
  vendorsPath = join(PROJECT_ROOT, 'config', 'vendors.json'),
  relaysPath = join(PROJECT_ROOT, 'config', 'relays.json'),
  modelsPath = join(PROJECT_ROOT, 'config', 'models.json'),
  timeRoutesPath = join(PROJECT_ROOT, 'runtime', 'time_routes.json'),
  sqliteSnapshotLoader = null,
  registryPath = '',
} = {}) {
  if (!functionRegistry?.auth) throw new Error('runtime-config: functionRegistry.auth is required');
  const paths = Object.freeze({
    envFile, vendorsPath, relaysPath, modelsPath, timeRoutesPath, registryPath,
  });
  let cached = null;

  function load() {
    const envText = readOptional(envFile);
    const fileEnv = parseDotenv(envText);
    applyLegacyEnvAliases(fileEnv, { warn: false });
    const bootstrapEnv = { ...fileEnv, ...processEnvOverrides };
    const requestedBackend = normalizeConfigBackend(bootstrapEnv.TOMATO_TAP_CONFIG_BACKEND);
    const candidateSnapshot = requestedBackend !== 'files' && sqliteSnapshotLoader
      ? sqliteSnapshotLoader()
      : null;
    const configBackend = selectConfigBackend({
      requested: requestedBackend,
      registrySnapshot: candidateSnapshot,
    });
    const registrySnapshot = configBackend.registrySnapshot;
    const storedEnv = registrySnapshot ? registrySnapshot.env : fileEnv;
    const env = Object.freeze({ ...storedEnv, ...processEnvOverrides });
    const vendorDocument = readRequired(vendorsPath);
    const relayDocument = registrySnapshot
      ? JSON.stringify(registrySnapshot.relays)
      : readRequired(relaysPath);
    const modelDocument = registrySnapshot
      ? JSON.stringify(registrySnapshot.models)
      : readRequired(modelsPath);
    const timeRoutesDocument = readOptional(timeRoutesPath);
    const vendorDefinitions = JSON.parse(vendorDocument).vendors || [];
    const digest = createHash('sha256');
    for (const [label, value] of [
      ['env', envText],
      ['vendors', vendorDocument],
      ['relays', relayDocument],
      ['models', modelDocument],
      ['time-routes', timeRoutesDocument],
      ['config-backend', `${configBackend.requested}:${configBackend.effective}`],
    ]) {
      digest.update(label).update('\0').update(value).update('\0');
    }
    if (registrySnapshot) {
      digest.update('config-registry').update('\0')
        .update(String(registrySnapshot.revision)).update('\0');
    }
    for (const vendor of vendorDefinitions) {
      if (vendor.envDiscovery !== 'dump_file' || !vendor.envDumpPath) continue;
      const dumpPath = env[vendor.envDumpPath];
      if (!dumpPath) continue;
      digest.update(`dump:${vendor.id}`).update('\0').update(readOptional(dumpPath)).update('\0');
    }
    const revision = digest.digest('hex').slice(0, 16);
    if (cached?.revision === revision) return cached;

    const { VENDORS, VENDOR_CAP_OVERRIDES, schemaVersion: vendorSchemaVersion } = loadVendors(
      functionRegistry,
      { path: vendorsPath },
    );
    const relayRegistry = loadRelayRegistry({
      path: registrySnapshot ? registryPath : relaysPath,
      document: registrySnapshot?.relays,
    });
    const modelPolicy = loadModelPolicy({
      path: registrySnapshot ? registryPath : modelsPath,
      document: registrySnapshot?.models,
    });
    const timeRoutePolicy = timeRoutesDocument
      ? loadTimeRoutePolicy({ path: timeRoutesPath })
      : loadTimeRoutePolicy();
    validateCrossReferences({ VENDORS, relayRegistry, modelPolicy, env });

    cached = Object.freeze({
      revision,
      loadedAt: Date.now(),
      env,
      VENDORS: Object.freeze(VENDORS),
      VENDOR_CAP_OVERRIDES: Object.freeze(VENDOR_CAP_OVERRIDES),
      relayRegistry,
      configBackend: Object.freeze({
        requested: configBackend.requested,
        effective: configBackend.effective,
      }),
      modelPolicy,
      timeRoutePolicy,
      vendorSchemaVersion,
      paths,
    });
    return cached;
  }

  return Object.freeze({ load, paths });
}

export function createRuntimeConfigWatcher({
  loader,
  initialRevision,
  intervalMs = 2_000,
  onCandidate,
  onError = () => {},
} = {}) {
  if (!loader?.load) throw new Error('runtime-config watcher requires loader');
  if (typeof onCandidate !== 'function') throw new Error('runtime-config watcher requires onCandidate');
  let revision = String(initialRevision || '');
  let timer = null;
  let checking = false;
  let lastCheckAt = 0;
  let lastSuccessAt = 0;
  let lastErrorAt = 0;
  let lastError = '';

  async function check() {
    if (checking) return false;
    checking = true;
    lastCheckAt = Date.now();
    try {
      const candidate = loader.load();
      if (candidate.revision === revision) return false;
      await onCandidate(candidate);
      revision = candidate.revision;
      lastSuccessAt = Date.now();
      lastError = '';
      return true;
    } catch (error) {
      const nextError = sanitizeReloadError(error);
      if (nextError !== lastError) {
        lastErrorAt = Date.now();
        lastError = nextError;
        onError(lastError);
      }
      return false;
    } finally {
      checking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { check(); }, Math.max(250, Number(intervalMs) || 2_000));
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function status() {
    return {
      revision,
      checking,
      interval_ms: Math.max(250, Number(intervalMs) || 2_000),
      last_check_at: lastCheckAt || null,
      last_success_at: lastSuccessAt || null,
      last_error_at: lastErrorAt || null,
      last_error: lastError || null,
    };
  }

  return Object.freeze({ check, start, stop, status });
}

function validateCrossReferences({ VENDORS, relayRegistry, modelPolicy, env }) {
  for (const [, vendor] of Object.entries(VENDORS)) {
    if (vendor.envDiscovery !== 'multi') continue;
    for (const name of Object.keys(env)) {
      const match = name.match(vendor.envPrefix);
      if (!match?.[1]) continue;
      if (!relayRegistry.relays[match[1]]) {
        throw new Error(`runtime-config: relay credential has no metadata: ${match[1]}`);
      }
    }
  }
  for (const logical of modelPolicy.logicalModels.values()) {
    for (const model of logical.candidates) {
      if (!modelPolicy.realModels.has(model.toLowerCase())) {
        throw new Error(`runtime-config: logical model ${logical.name} references unknown model ${model}`);
      }
    }
  }
}

function readRequired(path) {
  if (!path || !existsSync(path)) throw new Error(`runtime-config: required file missing: ${path || '(unset)'}`);
  return readFileSync(path, 'utf8');
}

function readOptional(path) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function sanitizeReloadError(error) {
  return String(error?.message || 'configuration reload failed')
    .replace(/(sk|tp|ark|ak)_[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/(sk|tp|ark|ak)-[A-Za-z0-9._-]+/gi, '[redacted]')
    .slice(0, 512);
}
