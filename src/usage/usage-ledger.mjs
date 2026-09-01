import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { parseDuration, parseSize } from '../config/config-values.mjs';

const DEFAULT_MAX_FILE_SIZE = '1GiB';
const DEFAULT_ARCHIVE_MAX_SIZE = '4GiB';
const DEFAULT_RETENTION = '90d';
const DEFAULT_MAINTENANCE_INTERVAL = '5m';

export function usageLedgerConfig(env = process.env) {
  return Object.freeze({
    maxFileBytes: parseSize(
      env.TOMATO_TAP_USAGE_LOG_MAX_SIZE || DEFAULT_MAX_FILE_SIZE,
      'TOMATO_TAP_USAGE_LOG_MAX_SIZE',
    ),
    archiveMaxBytes: parseSize(
      env.TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE || DEFAULT_ARCHIVE_MAX_SIZE,
      'TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE',
    ),
    retentionMs: parseDuration(
      env.TOMATO_TAP_USAGE_RETENTION || DEFAULT_RETENTION,
      'TOMATO_TAP_USAGE_RETENTION',
    ),
    maintenanceIntervalMs: parseDuration(
      env.TOMATO_TAP_USAGE_MAINTENANCE_INTERVAL || DEFAULT_MAINTENANCE_INTERVAL,
      'TOMATO_TAP_USAGE_MAINTENANCE_INTERVAL',
    ),
  });
}

export function createUsageLedger({
  path,
  env = process.env,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!path) throw new Error('usage-ledger: path is required');
  const config = usageLedgerConfig(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { if (existsSync(path)) chmodSync(path, 0o600); } catch { /* best effort */ }

  let currentBytes = fileSize(path);
  let stream = openStream();
  let rotating = false;
  let rotationPromise = null;
  let cleanupPromise = null;
  let closed = false;
  let pending = [];
  let healthy = true;
  let lastError = '';
  let rotations = 0;
  let lastRotationAt = null;
  let lastCleanupAt = null;
  let lastCleanup = { scanned: 0, deleted: 0, freedBytes: 0, keptBytes: 0 };

  const maintenanceTimer = setInterval(() => {
    if (currentBytes >= config.maxFileBytes) void rotateNow('size');
    else void cleanupNow();
  }, config.maintenanceIntervalMs);
  maintenanceTimer.unref?.();
  if (currentBytes >= config.maxFileBytes) queueMicrotask(() => { void rotateNow('startup-size'); });
  else queueMicrotask(() => { void cleanupNow(); });

  function openStream() {
    const output = createWriteStream(path, { flags: 'a', mode: 0o600 });
    output.on('error', (error) => markError(error));
    return output;
  }

  function markError(error) {
    healthy = false;
    lastError = String(error?.message || error).slice(0, 256);
    logger.error?.(`[usage-ledger] ${lastError}`);
  }

  function append(entry) {
    if (closed) return false;
    let line;
    try {
      line = typeof entry === 'string' ? entry : JSON.stringify(entry);
    } catch (error) {
      markError(new Error(`serialize failed: ${error.message}`));
      return false;
    }
    if (!line.endsWith('\n')) line += '\n';
    if (rotating) {
      pending.push(line);
      return healthy;
    }
    writeLine(line);
    if (currentBytes >= config.maxFileBytes) void rotateNow('size');
    return healthy;
  }

  function writeLine(line) {
    currentBytes += Buffer.byteLength(line);
    stream.write(line);
  }

  function rotateNow(reason = 'manual') {
    if (closed) return Promise.resolve(null);
    if (rotationPromise) return rotationPromise;
    rotating = true;
    rotationPromise = (async () => {
      await endStream(stream);
      const size = fileSize(path);
      let archivePath = null;
      if (size > 0) {
        archivePath = uniqueArchivePath(path, now());
        renameSync(path, archivePath);
        try { chmodSync(archivePath, 0o600); } catch { /* best effort */ }
        rotations += 1;
        lastRotationAt = new Date(now()).toISOString();
        logger.log?.(
          `[usage-ledger] rotated reason=${reason} bytes=${size} archive=${basename(archivePath)}`,
        );
      }
      currentBytes = 0;
      stream = openStream();
      const queued = pending;
      pending = [];
      for (const line of queued) writeLine(line);
      rotating = false;
      await cleanupNow();
      if (currentBytes >= config.maxFileBytes) queueMicrotask(() => { void rotateNow('queued-size'); });
      return archivePath;
    })().catch((error) => {
      markError(new Error(`rotation failed: ${error.message}`));
      try {
        if (!stream || stream.destroyed) stream = openStream();
        currentBytes = fileSize(path);
        const queued = pending;
        pending = [];
        for (const line of queued) writeLine(line);
      } catch (recoveryError) {
        markError(new Error(`rotation recovery failed: ${recoveryError.message}`));
      }
      rotating = false;
      return null;
    }).finally(() => {
      rotationPromise = null;
    });
    return rotationPromise;
  }

  async function cleanupNow() {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const result = await cleanupUsageArchives({
          path,
          retentionMs: config.retentionMs,
          maxBytes: config.archiveMaxBytes,
          nowMs: now(),
        }).catch((error) => {
          markError(new Error(`archive cleanup failed: ${error.message}`));
          return lastCleanup;
        });
        lastCleanupAt = new Date(now()).toISOString();
        lastCleanup = result;
        if (result.deleted > 0) {
          logger.log?.(
            `[usage-ledger] cleanup scanned=${result.scanned} deleted=${result.deleted} ` +
            `freed_bytes=${result.freedBytes} kept_bytes=${result.keptBytes}`,
          );
        }
        return { ...result };
      })().finally(() => {
        cleanupPromise = null;
      });
    }
    return { ...(await cleanupPromise) };
  }

  function status() {
    return {
      healthy,
      error: lastError || null,
      path,
      current_bytes: currentBytes,
      max_file_bytes: config.maxFileBytes,
      archive_max_bytes: config.archiveMaxBytes,
      retention_ms: config.retentionMs,
      maintenance_interval_ms: config.maintenanceIntervalMs,
      rotating,
      pending_rows: pending.length,
      rotations,
      last_rotation_at: lastRotationAt,
      last_cleanup_at: lastCleanupAt,
      last_cleanup: { ...lastCleanup },
    };
  }

  async function close() {
    if (closed) return;
    clearInterval(maintenanceTimer);
    if (rotationPromise) await rotationPromise;
    closed = true;
    await endStream(stream);
  }

  return Object.freeze({ append, rotateNow, cleanupNow, status, close });
}

export async function listUsageLogFiles(path) {
  const directory = dirname(path);
  const name = basename(path);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const paths = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === name || isArchiveName(entry.name, name)) {
      paths.push(join(directory, entry.name));
    }
  }
  return paths.sort((left, right) => {
    if (left === path) return 1;
    if (right === path) return -1;
    return left.localeCompare(right);
  });
}

async function cleanupUsageArchives({ path, retentionMs, maxBytes, nowMs }) {
  const directory = dirname(path);
  const name = basename(path);
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
    if (!entry.isFile() || !isArchiveName(entry.name, name)) continue;
    const archivePath = join(directory, entry.name);
    try {
      const stat = await lstat(archivePath);
      files.push({ path: archivePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  let deleted = 0;
  let freedBytes = 0;
  let keptBytes = files.reduce((total, file) => total + file.size, 0);
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

function uniqueArchivePath(path, nowMs) {
  const timestamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  let candidate = `${path}.${timestamp}.${process.pid}.jsonl`;
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = `${path}.${timestamp}.${process.pid}-${suffix}.jsonl`;
  }
  return candidate;
}

function isArchiveName(value, base) {
  return value.startsWith(`${base}.`) && value.endsWith('.jsonl');
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function endStream(stream) {
  if (!stream || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolve) => stream.end(resolve));
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
