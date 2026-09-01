import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

import { createSampleLogger, sampleLoggingConfig } from '../src/telemetry/sample-logger.mjs';

test('sample logging is disabled by default and does not create files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mimo-samples-off-'));
  const directory = join(temp, 'samples');
  try {
    const samples = createSampleLogger({ directory, env: {}, logger: quietLogger() });
    const stream = samples.open('request.log');
    stream.write('secret request body');
    stream.end();
    assert.equal(samples.status().enabled, false);
    assert.equal(existsSync(directory), false);
    samples.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('enabled sample logging uses private permissions', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'mimo-samples-on-'));
  const directory = join(temp, 'samples');
  try {
    const samples = createSampleLogger({
      directory,
      env: {
        TOMATO_TAP_SAMPLES_ENABLED: 'true',
        TOMATO_TAP_SAMPLES_RETENTION: '1d',
        TOMATO_TAP_SAMPLES_MAX_SIZE: '1MiB',
        TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL: '1d',
      },
      logger: quietLogger(),
    });
    const stream = samples.open('request.log');
    stream.end('request and response');
    await once(stream, 'close');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'request.log')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(directory, 'request.log'), 'utf8'), 'request and response');
    assert.throws(() => samples.open('../escape.log'), /plain \.log name/);
    samples.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('cleanup removes expired files then oldest files until below size cap', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'mimo-samples-clean-'));
  const directory = join(temp, 'samples');
  const nowMs = Date.parse('2026-08-30T12:00:00Z');
  try {
    const samples = createSampleLogger({
      directory,
      env: {
        TOMATO_TAP_SAMPLES_ENABLED: '1',
        TOMATO_TAP_SAMPLES_RETENTION: '1h',
        TOMATO_TAP_SAMPLES_MAX_SIZE: '10B',
        TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL: '1d',
      },
      logger: quietLogger(),
      now: () => nowMs,
    });
    await samples.cleanupNow();

    const old = join(directory, 'old.log');
    const middle = join(directory, 'middle.log');
    const newest = join(directory, 'newest.log');
    writeFileSync(old, '1234');
    writeFileSync(middle, '123456');
    writeFileSync(newest, 'abcdef');
    setAge(old, nowMs - 2 * 60 * 60 * 1000);
    setAge(middle, nowMs - 30 * 60 * 1000);
    setAge(newest, nowMs - 10 * 60 * 1000);

    const result = await samples.cleanupNow();
    assert.deepEqual(result, {
      scanned: 3,
      deleted: 2,
      freedBytes: 10,
      keptBytes: 6,
    });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(middle), false);
    assert.equal(existsSync(newest), true);
    samples.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('human-readable config and compatibility aliases are parsed strictly', () => {
  const config = sampleLoggingConfig({
    TOMATO_TAP_SAMPLES_ENABLED: 'on',
    TOMATO_TAP_SAMPLES_RETENTION_DAYS: '2',
    TOMATO_TAP_SAMPLES_MAX_SIZE_GB: '1.5',
    TOMATO_TAP_SAMPLES_CLEANUP_INTERVAL: '30m',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.retentionMs, 2 * 86_400_000);
  assert.equal(config.maxBytes, Math.round(1.5 * 1024 ** 3));
  assert.equal(config.cleanupIntervalMs, 30 * 60_000);
  assert.throws(
    () => sampleLoggingConfig({ TOMATO_TAP_SAMPLES_ENABLED: 'maybe' }),
    /must be true\/false/,
  );
});

function setAge(path, ms) {
  const date = new Date(ms);
  utimesSync(path, date, date);
}

function quietLogger() {
  return { log() {}, warn() {} };
}
