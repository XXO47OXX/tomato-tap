import {
  chmodSync,
  createWriteStream,
  mkdirSync,
} from 'node:fs';
import {
  lstat,
  readdir,
  unlink,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseBoolean, parseDuration, parseSize } from '../config/config-values.mjs';

const DEFAULT_RETENTION = '24h';
const DEFAULT_MAX_SIZE = '512MiB';
const DEFAULT_CLEANUP_INTERVAL = '1h';

const NOOP_LOG = Object.freeze({
  write() { return true; },
  end() {},
});

export function sampleLoggingConfig(env = process.env) {
  const retention = env.TOMATO_TAP_SAMPLES_RETENTION
    || (env.TOMATO_TAP_SAMPLES_RETENTION_DAYS
      ? `${env.TOMATO_TAP_SAMPLES_RETENTION_DAYS}d`
      : DEFAULT_RETENTION);
  const maxSize = env.TOMATO_TAP_SAMPLES_MAX_SIZE
    || (env.TOMATO_TAP_SAMPLES_MAX_SIZE_GB
      ? `${env.TOMATO_TAP_SAMPLES_MAX_SIZE_GB}GiB`
      : DEFAULT_MAX_SIZE);
  return Object.freeze({
    enabled: parseBoolean(
      env.TOMATO_TAP_SAMPLES_ENABLED,
      'TOMATO_TAP_SAMPLES_ENABLED',
    ),
    retentionMs: parseDuration(
      retention,
      'TOMATO_TAP_SAMPLES_RETENTION',
    ),
    maxBytes: parseSize(
      maxSize,
      'TOMATO_TAP_SAMPLES_MAX_SIZE',
    ),
    cleanupIntervalMs: parseDuration(
      env.TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL || DEFAULT_CLEANUP_INTERVAL,
      'TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL',
    ),
  });
}

export function createSampleLogger({
  directory,
  env = process.env,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!directory) throw new Error('sample-logger: directory is required');
  const config = sampleLoggingConfig(env);
  let cleanupTimer = null;
  let cleanupPromise = null;
  let lastCleanupAt = null;
  let lastCleanupError = '';
  let lastCleanup = { scanned: 0, deleted: 0, freedBytes: 0, keptBytes: 0 };

  if (config.enabled) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* best effort on mounted filesystems */ }
    void cleanupNow();
    cleanupTimer = setInterval(() => { void cleanupNow(); }, config.cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  function open(fileName) {
    if (!config.enabled) return NOOP_LOG;
    const safeName = basename(String(fileName || ''));
    if (!safeName || safeName !== fileName || !safeName.endsWith('.log')) {
      throw new Error('sample-logger: file name must be a plain .log name');
    }
    const stream = createWriteStream(join(directory, safeName), {
      flags: 'a',
      mode: 0o600,
    });
    stream.on('error', (error) => {
      logger.warn?.(`[sample-logger] write failed: ${error.message}`);
    });
    return stream;
  }

  async function cleanupNow() {
    if (!config.enabled) return { ...lastCleanup };
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = runCleanup({
      directory,
      retentionMs: config.retentionMs,
      maxBytes: config.maxBytes,
      nowMs: now(),
    }).then((result) => {
      lastCleanupAt = new Date(now()).toISOString();
      lastCleanupError = '';
      lastCleanup = result;
      if (result.deleted > 0) {
        logger.log?.(
          `[sample-logger] cleanup scanned=${result.scanned} deleted=${result.deleted} ` +
          `freed_bytes=${result.freedBytes} kept_bytes=${result.keptBytes}`,
        );
      }
      return { ...result };
    }).catch((error) => {
      lastCleanupAt = new Date(now()).toISOString();
      lastCleanupError = error.message;
      logger.warn?.(`[sample-logger] cleanup failed: ${error.message}`);
      return { ...lastCleanup };
    }).finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  }

  function status() {
    return {
      enabled: config.enabled,
      directory,
      retention_ms: config.retentionMs,
      max_bytes: config.maxBytes,
      cleanup_interval_ms: config.cleanupIntervalMs,
      last_cleanup_at: lastCleanupAt,
      last_cleanup_error: lastCleanupError || null,
      last_cleanup: { ...lastCleanup },
    };
  }

  function close() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  return Object.freeze({ open, cleanupNow, status, close });
}

async function runCleanup({ directory, retentionMs, maxBytes, nowMs }) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { scanned: 0, deleted: 0, freedBytes: 0, keptBytes: 0 };
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const path = join(directory, entry.name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);

  let deleted = 0;
  let freedBytes = 0;
  let keptBytes = files.reduce((sum, file) => sum + file.size, 0);
  const cutoff = nowMs - retentionMs;
  const kept = [];

  for (const file of files) {
    if (file.mtimeMs >= cutoff) {
      kept.push(file);
      continue;
    }
    if (await removeFile(file.path)) {
      deleted += 1;
      freedBytes += file.size;
      keptBytes -= file.size;
    }
  }

  for (const file of kept) {
    if (keptBytes <= maxBytes) break;
    if (await removeFile(file.path)) {
      deleted += 1;
      freedBytes += file.size;
      keptBytes -= file.size;
    }
  }

  return {
    scanned: files.length,
    deleted,
    freedBytes,
    keptBytes: Math.max(0, keptBytes),
  };
}

async function removeFile(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
