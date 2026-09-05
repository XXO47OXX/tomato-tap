import assert from 'node:assert/strict';
import {
  FALLBACK_ADMISSION_HIGHER_WEIGHT_QUOTA_CLOSED,
  normalizeFallbackAdmission,
  ordinaryCandidateAdmitted,
} from '../src/routing/ordinary-fallback-policy.mjs';

function key({ id, weight, models, fallbackAdmission = 'always' }) {
  return {
    deploymentId: id,
    vendor: 'direct',
    apiFormats: new Set(['anthropic', 'openai']),
    modelSet: new Set(models),
    baseWeight: weight,
    fallbackAdmission,
  };
}

const primary = key({ id: 'primary', weight: 10, models: ['shared-model'] });
const backup = key({
  id: 'backup',
  weight: 1,
  models: ['exclusive-model', 'shared-model'],
  fallbackAdmission: FALLBACK_ADMISSION_HIGHER_WEIGHT_QUOTA_CLOSED,
});
const pool = [primary, backup];
const admitted = (model, quota) => ordinaryCandidateAdmitted({
  candidate: backup,
  keyPool: pool,
  vendor: 'direct',
  requestedModel: model,
  format: 'anthropic',
  quotaStatus: () => quota,
});

assert.equal(admitted('exclusive-model', { managed: true, state: 'open' }), true);
assert.equal(admitted('shared-model', { managed: true, state: 'open' }), false);
assert.equal(admitted('shared-model', { managed: true, state: 'closed', closedKind: 'quota' }), true);
assert.equal(admitted('shared-model', { managed: true, state: 'closed', closedKind: 'probe_failure' }), false);
assert.equal(admitted('shared-model', { managed: false, state: 'open', closedKind: '' }), false);
assert.equal(normalizeFallbackAdmission(undefined), 'always');
assert.throws(() => normalizeFallbackAdmission('on-any-error'), /invalid fallback admission policy/);

console.log('All ordinary fallback policy tests passed.');
