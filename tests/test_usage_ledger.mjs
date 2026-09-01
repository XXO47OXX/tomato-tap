import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createUsageLedger,
  listUsageLogFiles,
  usageLedgerConfig,
} from '../src/usage/usage-ledger.mjs';

const quiet = { log() {}, error() {} };

test('usage ledger rotates atomically and preserves queued rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-usage-ledger-'));
  const path = join(dir, 'usage.log');
  const ledger = createUsageLedger({
    path,
    env: {
      TOMATO_TAP_USAGE_LOG_MAX_SIZE: '1KiB',
      TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE: '8KiB',
      TOMATO_TAP_USAGE_RETENTION: '7d',
      TOMATO_TAP_USAGE_MAINTENANCE_INTERVAL: '1h',
    },
    logger: quiet,
  });
  try {
    ledger.append({ ts: '2026-08-30T00:00:00.000Z', id: 1 });
    const rotation = ledger.rotateNow('test');
    ledger.append({ ts: '2026-08-30T00:00:01.000Z', id: 2 });
    await rotation;
    await ledger.close();

    const paths = await listUsageLogFiles(path);
    assert.equal(paths.length, 2);
    const rows = paths.flatMap((file) => readFileSync(file, 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.id).sort(), [1, 2]);
    for (const file of paths) assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage archive cleanup enforces retention without touching the active log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-usage-clean-'));
  const path = join(dir, 'usage.log');
  const old = `${path}.2026-01-01.jsonl`;
  writeFileSync(path, '{"active":true}\n');
  writeFileSync(old, '{"old":true}\n');
  chmodSync(old, 0o644);
  const oldDate = new Date('2026-01-01T00:00:00.000Z');
  utimesSync(old, oldDate, oldDate);
  const ledger = createUsageLedger({
    path,
    env: {
      TOMATO_TAP_USAGE_LOG_MAX_SIZE: '1MiB',
      TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE: '2MiB',
      TOMATO_TAP_USAGE_RETENTION: '1d',
      TOMATO_TAP_USAGE_MAINTENANCE_INTERVAL: '1h',
    },
    logger: quiet,
    now: () => new Date('2026-08-30T00:00:00.000Z').getTime(),
  });
  try {
    const [result, duplicate] = await Promise.all([
      ledger.cleanupNow(),
      ledger.cleanupNow(),
    ]);
    assert.equal(result.deleted, 1);
    assert.equal(duplicate.deleted, 1);
    assert.deepEqual(await listUsageLogFiles(path), [path]);
    assert.equal(readFileSync(path, 'utf8'), '{"active":true}\n');
  } finally {
    await ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage ledger configuration has conservative defaults and strict units', () => {
  const config = usageLedgerConfig({});
  assert.equal(config.maxFileBytes, 1024 ** 3);
  assert.equal(config.archiveMaxBytes, 4 * 1024 ** 3);
  assert.equal(config.retentionMs, 90 * 86_400_000);
  assert.throws(() => usageLedgerConfig({ TOMATO_TAP_USAGE_LOG_MAX_SIZE: 'large' }), /must be a size/);
});
