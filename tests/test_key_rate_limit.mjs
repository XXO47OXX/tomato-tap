import assert from 'node:assert/strict';

import { createInitialKeyState } from '../src/state/key-state.mjs';
import { consumeRateLimit, rateLimitStatus } from '../src/state/key-rate-limit.mjs';

const paced = createInitialKeyState(1);
const pacedPolicy = { requestsPerMinute: 60, mode: 'paced' };
assert.equal(consumeRateLimit(paced, pacedPolicy, 10_000), true);
assert.equal(rateLimitStatus(paced, pacedPolicy, 10_999).allowed, false);
assert.equal(rateLimitStatus(paced, pacedPolicy, 10_999).retryAt, 11_000);
assert.equal(consumeRateLimit(paced, pacedPolicy, 11_000), true);

const fixed = createInitialKeyState(1);
const fixedPolicy = { requestsPerMinute: 2, mode: 'fixed-window' };
assert.equal(consumeRateLimit(fixed, fixedPolicy, 10_000), true);
assert.equal(consumeRateLimit(fixed, fixedPolicy, 20_000), true);
assert.equal(consumeRateLimit(fixed, fixedPolicy, 30_000), false);
assert.equal(rateLimitStatus(fixed, fixedPolicy, 30_000).retryAt, 60_000);
assert.equal(consumeRateLimit(fixed, fixedPolicy, 60_000), true);

assert.equal(consumeRateLimit(createInitialKeyState(1), null, 10_000), true);

console.log('test_key_rate_limit: ok');
