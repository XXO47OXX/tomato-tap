import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;
const WINDOW_FIELDS = new Set([
  'deploymentId',
  'state',
  'closedReason',
  'closedKind',
  'closedAt',
  'nextProbeAt',
  'openedAt',
  'boostedUntil',
  'lastProbeStatus',
  'consecutiveProbeFailures',
]);
const STATES = new Set(['open', 'closed', 'half_open', 'boosted']);
const CLOSED_KINDS = new Set(['', 'quota', 'probe_failure', 'state']);

export function loadQuotaState(path) {
  if (!existsSync(path)) return { corrupt: false, windows: [] };
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (document?.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`unsupported schemaVersion ${document?.schemaVersion}`);
    }
    if (!Array.isArray(document.windows)) throw new Error('windows must be an array');
    return {
      corrupt: false,
      windows: document.windows.map(validateWindow),
    };
  } catch {
    const corruptPath = `${path}.corrupt-${Date.now()}-${process.pid}`;
    try {
      renameSync(path, corruptPath);
    } catch {
      // The caller still fails closed even if preserving the bad file fails.
    }
    return { corrupt: true, windows: [] };
  }
}

export function saveQuotaState(path, snapshot, now = Date.now()) {
  if (!Array.isArray(snapshot)) throw new Error('quota-state-store: snapshot must be an array');
  const windows = snapshot.map(validateWindow);
  const directory = dirname(path);
  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) chmodSync(directory, 0o700);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    windows,
  }, null, 2)}\n`;

  let fd;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd != null) closeSync(fd);
  }
  renameSync(tempPath, path);
  try {
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}

function validateWindow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('quota-state-store: window must be an object');
  }
  for (const field of Object.keys(input)) {
    if (!WINDOW_FIELDS.has(field)) {
      throw new Error(`quota-state-store: unknown field "${field}"`);
    }
  }
  if (typeof input.deploymentId !== 'string' || !input.deploymentId) {
    throw new Error('quota-state-store: deploymentId must be a non-empty string');
  }
  if (!STATES.has(input.state)) {
    throw new Error(`quota-state-store: invalid state "${input.state}"`);
  }
  if (typeof input.closedReason !== 'string') {
    throw new Error('quota-state-store: closedReason must be a string');
  }
  const number = (field) => {
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`quota-state-store: ${field} must be a non-negative number`);
    }
    return value;
  };
  if (input.closedKind != null && !CLOSED_KINDS.has(input.closedKind)) {
    throw new Error(`quota-state-store: invalid closedKind "${input.closedKind}"`);
  }
  return {
    deploymentId: input.deploymentId,
    state: input.state,
    closedReason: input.closedReason,
    ...(input.closedKind != null ? { closedKind: input.closedKind } : {}),
    closedAt: number('closedAt'),
    nextProbeAt: number('nextProbeAt'),
    openedAt: number('openedAt'),
    boostedUntil: number('boostedUntil'),
    lastProbeStatus: number('lastProbeStatus'),
    consecutiveProbeFailures: number('consecutiveProbeFailures'),
  };
}
