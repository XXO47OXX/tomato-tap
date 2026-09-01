import assert from 'node:assert/strict';
import { applyKeyOutcome, createInitialKeyState } from '../src/state/key-state.mjs';

const key = { name: 'relay-a', vendor: 'relay' };
const policy = {
  capGrowAfter: 2,
  cooldown429DefaultMs: 100,
  cooldown429MaxMs: 1000,
  consecutive403Threshold: 2,
  cooldown403Ms: 500,
  model403CooldownMs: 300,
  consecutive5xxThreshold: 2,
  cooldown5xxMs: 50,
  persistent5xxCooldownMs: 200,
  deadModelCooldownMs: 700,
};

const success = createInitialKeyState(2);
apply(success, 200, { now: 1000 });
apply(success, 200, { now: 1001 });
assert.equal(success.cap, 3);

const limited = createInitialKeyState(4);
apply(limited, 429, { now: 2000, retryAfterMs: 800 });
assert.equal(limited.cap, 2);
assert.equal(limited.badUntil, 2800);
assert.equal(limited.cooldownReason, 'quota_429');

const fixedDirect = createInitialKeyState(20);
apply(fixedDirect, 429, { now: 2500, retryAfterMs: 800, capMin: 20, capMax: 20 });
assert.equal(fixedDirect.cap, 20);
assert.equal(fixedDirect.badUntil, 3300);

const modelForbidden = createInitialKeyState(2);
apply(modelForbidden, 403, { now: 3000, requestedModel: 'grok-4.5' });
assert.equal(modelForbidden.deadModels.get('grok-4.5'), 3300);
assert.equal(modelForbidden.badUntil, 0);

const deadModel = createInitialKeyState(2);
apply(deadModel, 404, { now: 4000, requestedModel: 'missing' });
assert.equal(deadModel.deadModels.get('missing'), 4700);

const auth = createInitialKeyState(4);
apply(auth, 401, { now: 5000, auth401CooldownMs: 900 });
assert.equal(auth.cap, 1);
assert.equal(auth.badUntil, 5900);

function apply(state, status, overrides = {}) {
  applyKeyOutcome({
    state,
    key,
    status,
    retryAfterMs: null,
    requestedModel: '',
    capMin: 1,
    capMax: 8,
    auth401CooldownMs: 1000,
    policy,
    logger: { warn() {} },
    ...overrides,
  });
}

console.log('test_key_state: ok');
