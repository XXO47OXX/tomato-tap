import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextRoute429Recovery,
  routeCandidateIndexes,
  routeTriedCount,
} from '../src/routing/route-retry.mjs';

const keys = [
  { vendor: 'direct', apiFormats: new Set(['anthropic']), modelSet: new Set(['kimi-k3']) },
  { vendor: 'direct', apiFormats: new Set(['anthropic', 'openai']), modelSet: new Set(['deepseek-v4-flash']) },
  { vendor: 'relay', apiFormats: new Set(['openai']), modelSet: new Set(['kimi-k3']) },
];

test('candidate accounting is scoped to vendor, protocol and model', () => {
  const indexes = routeCandidateIndexes(keys, {
    vendor: 'direct', requestedModel: 'kimi-k3', format: 'anthropic',
  });
  assert.deepEqual(indexes, [0]);
  assert.equal(routeTriedCount(indexes, new Set([0, 2])), 1);
});

test('short route 429 cooldown is recoverable', () => {
  const now = 10_000;
  const recovery = nextRoute429Recovery([0], [{
    cooldownReason: 'quota_429', badUntil: now + 30_000,
  }], { now, maxWaitMs: 35_000 });
  assert.deepEqual(recovery, { keyIndex: 0, delayMs: 30_000 });
});

test('long or non-429 cooldown is not waited', () => {
  const now = 10_000;
  assert.equal(nextRoute429Recovery([0], [{
    cooldownReason: 'quota_429', badUntil: now + 36_000,
  }], { now, maxWaitMs: 35_000 }), null);
  assert.equal(nextRoute429Recovery([0], [{
    cooldownReason: 'auth_401', badUntil: now + 1_000,
  }], { now, maxWaitMs: 35_000 }), null);
});
