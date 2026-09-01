import assert from 'node:assert/strict';

import { buildKeyPoolStatus } from '../src/gateway/key-pool-status.mjs';
import { applyKeyOutcome, createInitialKeyState } from '../src/state/key-state.mjs';

const now = 10_000;
const key = {
  name: 'relay-a',
  deploymentId: 'relay-a',
  providerLabel: 'provider-a',
  vendor: 'relay',
  host: 'upstream.example',
  expiresAtMs: 0,
};
const state = createInitialKeyState(4);

applyKeyOutcome({
  state,
  key,
  status: 503,
  requestedModel: 'model-a',
  capMin: 1,
  capMax: 8,
  auth401CooldownMs: 60_000,
  now,
  logger: { warn: () => {} },
});

assert.equal(state.cooldownReason, 'upstream_5xx');
assert.equal(state.cap, 2);
const status = buildKeyPoolStatus({
  keys: [key],
  states: [state],
  stickyRuntime: { statusForKey: () => ({}) },
  now: now + 1,
});
assert.equal(status[0].cooldown_reason, 'upstream_5xx');
assert.ok(status[0].cooldown_remaining_ms > 0);

applyKeyOutcome({
  state,
  key,
  status: 200,
  requestedModel: 'model-a',
  capMin: 1,
  capMax: 8,
  auth401CooldownMs: 60_000,
  now: now + 2,
  logger: { warn: () => {} },
});
assert.equal(state.cooldownReason, null);

console.log('test_proxy_cooldown_integration: ok');
