import assert from 'node:assert/strict';
import { createInitialKeyState } from '../src/state/key-state.mjs';
import {
  activeCooldownReason,
  applyCooldownRecords,
  exportCooldownRecords,
  setKeyCooldown,
} from '../src/state/key-cooldown.mjs';

const NOW = 1_000_000;
const keyOf = (i) => `fp-${i}`;

// exportCooldownRecords keeps only still-active cooldowns.
{
  const states = [createInitialKeyState(4), createInitialKeyState(4), createInitialKeyState(4)];
  setKeyCooldown(states[0], 'quota_429', NOW + 60_000);
  setKeyCooldown(states[1], 'auth_401', NOW - 1); // expired
  setKeyCooldown(states[1], 'auth_401', NOW + 120_000); // later, still future
  const records = exportCooldownRecords(states, keyOf, NOW);
  assert.deepEqual(Object.keys(records).sort(), ['fp-0', 'fp-1'], 'expired cooldown is dropped');
  assert.equal(records['fp-0'].badUntil, NOW + 60_000);
  assert.equal(records['fp-0'].reason, 'quota_429');
  assert.equal(records['fp-1'].badUntil, NOW + 120_000);
  assert.equal(records['fp-1'].reason, 'auth_401');
}

// Empty export when nothing is cooled.
{
  const states = [createInitialKeyState(4)];
  assert.deepEqual(exportCooldownRecords(states, keyOf, NOW), {});
}

// applyCooldownRecords restores future cooldowns onto fresh states.
{
  const states = [createInitialKeyState(4), createInitialKeyState(4)];
  const applied = applyCooldownRecords({
    'fp-0': { badUntil: NOW + 300_000, reason: 'quota_429' },
    'fp-1': { badUntil: NOW - 1, reason: 'auth_401' },          // expired → skipped
    'unknown': { badUntil: NOW + 500_000, reason: 'auth_401' }, // no matching key → ignored
  }, states, keyOf, NOW);
  assert.equal(applied, 1);
  assert.equal(activeCooldownReason(states[0], NOW), 'quota_429');
  assert.equal(states[0].badUntil, NOW + 300_000);
  assert.equal(states[1].badUntil, 0, 'expired record must not cool a fresh key');
}

// Roundtrip: export → apply reproduces the same live cooldowns.
{
  const original = [createInitialKeyState(4), createInitialKeyState(4), createInitialKeyState(4)];
  setKeyCooldown(original[0], 'quota_429', NOW + 900_000);
  setKeyCooldown(original[2], 'proxy_transport', NOW + 60_000);
  const records = exportCooldownRecords(original, keyOf, NOW);

  const restored = [createInitialKeyState(4), createInitialKeyState(4), createInitialKeyState(4)];
  assert.equal(applyCooldownRecords(records, restored, keyOf, NOW), 2);
  for (let i = 0; i < 3; i++) {
    assert.equal(restored[i].badUntil, original[i].badUntil, `state ${i} badUntil roundtrips`);
    assert.equal(restored[i].cooldownReason, original[i].cooldownReason, `state ${i} reason roundtrips`);
  }
}

// setKeyCooldown merge semantics protect longer existing cooldowns.
{
  const states = [createInitialKeyState(4)];
  states[0].badUntil = NOW + 10 * 60_000;
  states[0].cooldownReason = 'quota_429';
  applyCooldownRecords({ 'fp-0': { badUntil: NOW + 60_000, reason: 'mixed_error' } }, states, keyOf, NOW);
  assert.equal(states[0].badUntil, NOW + 10 * 60_000, 'shorter persisted cooldown never shortens');
  assert.equal(states[0].cooldownReason, 'quota_429', 'protected reason wins over mixed_error');
}

// Malformed input degrades to a no-op.
{
  const states = [createInitialKeyState(4)];
  assert.equal(applyCooldownRecords(null, states, keyOf, NOW), 0);
  assert.equal(applyCooldownRecords([], states, keyOf, NOW), 0);
  assert.equal(applyCooldownRecords('junk', states, keyOf, NOW), 0);
  assert.equal(applyCooldownRecords({ 'fp-0': { badUntil: 'NaN', reason: 'auth_401' } }, states, keyOf, NOW), 0);
  assert.equal(states[0].badUntil, 0);
}

console.log('test_key_cooldown_persist: ok');
