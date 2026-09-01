import assert from 'node:assert/strict';
import {
  activeCooldownReason,
  advanceMixedErrorStreak,
  countsTowardMixedError,
  recoverTransientCooldown,
  setKeyCooldown,
} from '../src/state/key-cooldown.mjs';

assert.equal(countsTowardMixedError(0), false, 'network failures use retry, not the one-hour mixed cooldown');
assert.equal(countsTowardMixedError(429), false, 'quota responses keep their own recovery time');
assert.equal(countsTowardMixedError(503), true);
assert.equal(countsTowardMixedError(401), true);
assert.equal(countsTowardMixedError(403), true);
assert.equal(countsTowardMixedError(403, { modelScoped403: true }), false);
assert.equal(advanceMixedErrorStreak(7, 0), 0);
assert.equal(advanceMixedErrorStreak(7, 429), 0);
assert.equal(advanceMixedErrorStreak(7, 503), 8);
assert.equal(advanceMixedErrorStreak(7, 403, { modelScoped403: true }), 0);
assert.equal(advanceMixedErrorStreak(advanceMixedErrorStreak(7, 0), 503), 1);
assert.equal(advanceMixedErrorStreak(advanceMixedErrorStreak(7, 429), 503), 1);

for (const reason of ['mixed_error', 'upstream_5xx']) {
  const state = { badUntil: 0, cooldownReason: null };
  setKeyCooldown(state, reason, 60_000);
  assert.equal(activeCooldownReason(state, 1_000), reason);
  assert.equal(recoverTransientCooldown(state, 1_000), true);
  assert.equal(state.badUntil, 0);
  assert.equal(state.cooldownReason, null);
}

for (const reason of ['quota_429', 'auth_401', 'forbidden_403', 'proxy_transport']) {
  const state = { badUntil: 0, cooldownReason: null };
  setKeyCooldown(state, reason, 60_000);
  assert.equal(recoverTransientCooldown(state, 1_000), false);
  assert.equal(state.badUntil, 60_000);
  assert.equal(activeCooldownReason(state, 1_000), reason);
}

const precedence = { badUntil: 0, cooldownReason: null };
setKeyCooldown(precedence, 'auth_401', 30_000);
setKeyCooldown(precedence, 'upstream_5xx', 90_000);
assert.equal(precedence.cooldownReason, 'auth_401');
assert.equal(recoverTransientCooldown(precedence, 1_000), false);

const expired = { badUntil: 500, cooldownReason: 'mixed_error' };
assert.equal(activeCooldownReason(expired, 1_000), null);
assert.equal(expired.cooldownReason, null);

console.log('test_key_cooldown: ok');
