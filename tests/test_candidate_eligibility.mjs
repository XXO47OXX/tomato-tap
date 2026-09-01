import assert from 'node:assert/strict';
import {
  createCandidateQualificationRegistry,
  evaluateCandidate,
  nextEligibilityRetryDelay,
  summarizeEligibility,
} from '../src/routing/candidate-eligibility.mjs';

const now = 1_000_000;

const cases = [
  ['disabled', { disabled: true }, 'disabled', false, false],
  ['missing key', { credentialPresent: false }, 'missing_credential', false, false],
  ['expired', { expiresAt: now - 1 }, 'expired', false, false],
  ['vendor block', { vendorBlockedReason: 'daily cap' }, 'blocked', false, true],
  ['proxy', { proxyAvailable: false, proxyRecoveryAt: now + 1000 }, 'cooldown', false, true],
  ['quota', { quotaState: 'closed', quotaNextProbeAt: now + 2000 }, 'cooldown', false, true],
  ['key cooldown', { keyCooldownUntil: now + 3000 }, 'cooldown', false, true],
  ['model cooldown', { modelCooldownUntil: now + 4000 }, 'cooldown', false, true],
  ['logical cap', { logicalAdmissionFull: true }, 'congested', false, true],
  ['key cap', { keyCapacityFull: true }, 'congested', false, true],
  ['failed validation due for probe', { latestValidatedOutcome: false, failureClass: 'empty_content' }, 'probing', true, true],
  ['failed validation backoff', {
    latestValidatedOutcome: false,
    failureClass: 'empty_content',
    qualificationNextProbeAt: now + 5000,
  }, 'cooldown', false, true],
  ['unproven', {}, 'probing', true, true],
  ['ready', { latestValidatedOutcome: true }, 'ready', true, true],
];

for (const [label, input, state, dispatchable, retryable] of cases) {
  const result = evaluateCandidate(input, now);
  assert.equal(result.state, state, label);
  assert.equal(result.dispatchable, dispatchable, label);
  assert.equal(result.retryable, retryable, label);
  assert.equal(result.available, state === 'ready', label);
}

const combinedCooldown = evaluateCandidate({
  proxyAvailable: false,
  proxyRecoveryAt: now + 1000,
  quotaState: 'closed',
  quotaNextProbeAt: now + 5000,
  keyCooldownUntil: now + 3000,
}, now);
assert.equal(combinedCooldown.recoveryAt, now + 5000);
assert.deepEqual(combinedCooldown.reasons, ['proxy_unavailable', 'quota_closed', 'key_cooldown']);

const records = [
  { eligibility: evaluateCandidate({ latestValidatedOutcome: true }, now) },
  { eligibility: evaluateCandidate({ keyCapacityFull: true }, now) },
  { eligibility: evaluateCandidate({ quotaState: 'closed', quotaNextProbeAt: now + 2000 }, now) },
];
const summary = summarizeEligibility(records, now);
assert.equal(summary.health, 'available');
assert.equal(summary.available, 1);
assert.equal(summary.counts.congested, 1);
assert.equal(summary.nextRecoveryAt, now + 2000);

assert.equal(nextEligibilityRetryDelay(records.slice(1, 2), now, now + 5000), 50);
assert.equal(nextEligibilityRetryDelay(records.slice(2), now, now + 5000), 2000);
assert.equal(nextEligibilityRetryDelay(records.slice(2), now, now + 1000), 0);

const registry = createCandidateQualificationRegistry({
  historySize: 2,
  failureBackoffBaseMs: 100,
  failureBackoffMaxMs: 1000,
});
assert.equal(registry.get('relay-a', 'GLM-5.2'), null);
const firstFailure = registry.record({ deploymentId: 'relay-a', model: 'GLM-5.2', valid: false, failureClass: 'empty_content', identity: 'same', now });
assert.equal(firstFailure.consecutiveFailures, 1);
assert.equal(firstFailure.nextProbeAt, now + 100);
const secondFailure = registry.record({ deploymentId: 'relay-a', model: 'GLM-5.2', valid: false, failureClass: 'empty_content', identity: 'same', now: now + 1 });
assert.equal(secondFailure.consecutiveFailures, 2);
assert.equal(secondFailure.nextProbeAt, now + 201);
registry.record({ deploymentId: 'relay-a', model: 'glm-5.2', valid: true, latencyMs: 120, identity: 'same', now: now + 1 });
registry.record({ deploymentId: 'relay-a', model: 'glm-5.2', valid: true, latencyMs: 80, identity: 'same', now: now + 2 });
const qualification = registry.get('relay-a', 'GLM-5.2');
assert.equal(qualification.latestValidatedOutcome, true);
assert.equal(qualification.consecutiveFailures, 0);
assert.equal(qualification.nextProbeAt, 0);
assert.deepEqual(qualification.outcomes, [1, 1]);
assert.equal(registry.snapshot()[0].recent_attempts, 2);
const persisted = registry.exportState();
const restored = createCandidateQualificationRegistry();
assert.equal(restored.hydrate(persisted, { now: now + 3, maxAgeMs: 100 }), 1);
restored.reconcile([{ deploymentId: 'relay-a', model: 'glm-5.2', identity: 'rotated' }]);
assert.equal(restored.snapshot().length, 0);
registry.reconcile([{ deploymentId: 'relay-b', model: 'glm-5.2', identity: 'same' }]);
assert.equal(registry.snapshot().length, 0);

console.log('test_candidate_eligibility: ok');
