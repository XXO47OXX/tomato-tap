import assert from 'node:assert/strict';
import { createModelInventory } from '../src/gateway/model-inventory.mjs';
import { createLogicalScheduler } from '../src/routing/logical-scheduler.mjs';
import { loadModelPolicy } from '../src/routing/model-policy.mjs';

const modelPolicy = loadModelPolicy({
  path: new URL('../config/models.json', import.meta.url).pathname,
});
const now = Date.now();
const readyEligibility = Object.freeze({
  state: 'ready',
  reason: 'validated',
  dispatchable: true,
  available: true,
  retryable: true,
  recoveryAt: 0,
  recovery_at: null,
});

const runtime = {
  vendors: {
    example: {
      routes: [{ prefix: '/example/v1', format: 'openai' }],
    },
  },
  keyPool: [{
    vendor: 'example',
    deploymentId: 'example-1',
    canonicalModelSet: new Set(['example-model']),
    apiFormats: new Set(['openai']),
    expiresAtMs: 0,
  }],
  keyState: [{
    badUntil: 0,
    inflight: 0,
    cap: 2,
    deadModels: new Map(),
  }],
  modelPolicy,
  quotaManager: { snapshot: () => [] },
  quotaPersistenceHealthy: true,
  stickyRuntime: { isKeyAvailable: () => true },
  candidateQualifications: {
    get: () => ({
      latestValidatedOutcome: true,
      failureClass: '',
      lastValidatedAt: now,
    }),
  },
  modelInflight: new Map(),
};

const logicalDeployment = {
  model: 'example-model',
  deploymentId: 'example-1',
  vendor: 'example',
  capabilities: ['instruction_following'],
  qualityTier: 'standard',
  eligibility: readyEligibility,
  inflight: 0,
  cap: 2,
  modelInflight: 0,
  modelMaxInflight: 4,
  baseWeight: 1,
  initialLatencyMs: 1000,
  firstByteTimeoutMs: 3000,
  totalTimeoutMs: 10000,
  requestPolicy: { stream: false },
};

const inventory = createModelInventory({
  getRuntime: () => runtime,
  logicalDeployments: { list: () => [logicalDeployment] },
  vendorCap: () => Infinity,
  checkVendorConstraints: () => '',
  checkVendorPricingCoverage: () => '',
  keyRateLimitStatus: () => ({ retryAt: 0 }),
  logicalScheduler: createLogicalScheduler(),
});

const realModels = inventory.buildModelInventory(now);
assert.equal(realModels.length, 1);
assert.equal(realModels[0].id, 'example-model');
assert.equal(realModels[0].health, 'available');
assert.equal(realModels[0].routes[0].vendor, 'example');
assert.equal(realModels[0].routes[0].chat_completion_url, '/example/v1/chat/completions');
assert.equal(realModels[0].routes[0].ready_keys, 1);

const logicalModels = inventory.buildLogicalModelInventory({
  now,
  includeEligibilityDetails: true,
});
assert.equal(logicalModels.length, 1);
assert.equal(logicalModels[0].id, 'balanced');
assert.equal(logicalModels[0].health, 'available');
assert.equal(logicalModels[0].ready_deployments, 1);
assert.equal(logicalModels[0].candidate_eligibility[0].deployment, 'example-1');

const routePlan = inventory.buildLogicalRoutePlan({
  model: 'BALANCED',
  now,
  includeEligibilityDetails: true,
});
assert.equal(routePlan.logical_model, 'balanced');
assert.equal(routePlan.strategy.candidate, 'fair');
assert.equal(routePlan.dispatchable, true);
assert.equal(routePlan.selection.model, 'example-model');
assert.equal(routePlan.selection.deployment, 'example-1');
assert.equal(routePlan.deployments.length, 1);
assert.equal(routePlan.candidates[0].thinking_adapter, 'none');
assert.deepEqual(routePlan.deployments[0].request_policy, { stream: false });
assert.equal(routePlan.deployments.some((entry) => Object.hasOwn(entry, 'credential')), false);
assert.equal(inventory.buildLogicalRoutePlan({ model: 'missing', now }), null);

const excluded = inventory.buildLogicalModelInventory({
  now,
  excludedVendors: new Set(['example']),
});
assert.equal(excluded[0].health, 'unavailable');
assert.equal(excluded[0].eligible_deployments, 0);

console.log('test_model_inventory: ok');
