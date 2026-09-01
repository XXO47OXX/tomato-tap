import assert from 'node:assert/strict';
import {
  createLogicalScheduler,
  deploymentMatchesRequest,
  pairId,
  selectLogicalCandidate,
} from '../src/routing/logical-scheduler.mjs';

function request(overrides = {}) {
  return {
    logicalModel: 'balanced',
    taskName: 'structured-generation',
    candidates: ['strong', 'weak'],
    requiredCapabilities: ['long_output'],
    maxAttempts: 8,
    deadlineMs: 90000,
    maxInflight: 2,
    qualityTier: 'strong',
    sessionAffinity: false,
    allowWeakFallback: false,
    protected: false,
    minReadySlots: 0,
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    keyIndex: 0,
    deploymentId: 'strong-a',
    vendor: 'relay',
    model: 'strong',
    capabilities: ['long_output'],
    qualityTier: 'strong',
    cap: 2,
    inflight: 0,
    modelMaxInflight: 4,
    modelInflight: 0,
    badUntil: 0,
    deadUntil: 0,
    baseWeight: 1,
    initialLatencyMs: 1000,
    firstByteTimeoutMs: 2000,
    totalTimeoutMs: 5000,
    ...overrides,
  };
}

const eligibility = (state) => ({
  state,
  dispatchable: ['ready', 'probing', 'unhealthy'].includes(state),
});

{
  assert.equal(deploymentMatchesRequest(
    request(),
    deployment({ capabilities: ['strict_json'] }),
  ), false);
  assert.equal(deploymentMatchesRequest(request(), deployment()), true);
}

{
  const scheduler = createLogicalScheduler({ historySize: 4 });
  const deployments = [
    deployment({ deploymentId: 'slow', cap: 2 }),
    deployment({
      keyIndex: 1,
      deploymentId: 'weak',
      model: 'weak',
      qualityTier: 'standard',
      capabilities: [],
      cap: 20,
      baseWeight: 10,
    }),
  ];
  assert.equal(scheduler.select({ request: request(), deployments, now: 1000 }).deploymentId, 'slow');
}

{
  const scheduler = createLogicalScheduler();
  const lease = scheduler.enter(request({
    logicalModel: 'classifier',
    taskName: 'classification',
    protected: true,
    minReadySlots: 1,
  }));
  const ordinary = request({
    candidates: ['strong', 'other-strong', 'weak'],
    qualityTier: '',
    allowWeakFallback: true,
  });
  const deployments = [
    deployment({ keyIndex: 0, deploymentId: 'shared', model: 'strong', cap: 1, modelMaxInflight: 2, baseWeight: 10 }),
    deployment({ keyIndex: 0, deploymentId: 'shared', model: 'other-strong', cap: 1, modelMaxInflight: 2, baseWeight: 10 }),
    deployment({ keyIndex: 1, deploymentId: 'standard', model: 'weak', qualityTier: 'standard', baseWeight: 1 }),
  ];
  assert.equal(scheduler.select({ request: ordinary, deployments, now: 1000 }).deploymentId, 'standard');
  lease.release();
}

{
  const scheduler = createLogicalScheduler();
  const req = request({ candidates: ['strong', 'other'], candidateStrategy: 'ordered' });
  const selected = selectLogicalCandidate({
    scheduler,
    request: req,
    deployments: [
      deployment({ deploymentId: 'probing', model: 'strong', eligibility: eligibility('probing') }),
      deployment({ deploymentId: 'ready', model: 'other', keyIndex: 1, eligibility: eligibility('ready') }),
    ],
    now: 1000,
    sessionId: '',
    avoidModel: '',
    excludedPairs: new Set(),
    remainingMs: 5000,
    modelAttemptCounts: new Map(),
  });
  assert.equal(selected.deploymentId, 'ready', 'qualified ready model must beat an unproven ordered candidate');
}

{
  const scheduler = createLogicalScheduler();
  const selected = scheduler.select({
    request: request(),
    deployments: [
      deployment({ deploymentId: 'probing', eligibility: eligibility('probing'), initialLatencyMs: 500 }),
      deployment({ deploymentId: 'ready', keyIndex: 1, eligibility: eligibility('ready'), initialLatencyMs: 1000 }),
    ],
    now: 1000,
  });
  assert.equal(selected.deploymentId, 'ready', 'ready deployment must be preferred within the same model');
}

{
  const scheduler = createLogicalScheduler();
  const healthy = deployment({ deploymentId: 'healthy', keyIndex: 1 });
  assert.equal(scheduler.select({
    request: request(),
    deployments: [deployment({ badUntil: 2000 }), healthy],
    now: 1000,
  }).deploymentId, 'healthy');
  assert.equal(scheduler.select({
    request: request(),
    deployments: [deployment({ inflight: 2 }), healthy],
    now: 1000,
  }).deploymentId, 'healthy');
  assert.equal(scheduler.select({
    request: request(),
    deployments: [deployment({ modelInflight: 4 }), healthy],
    now: 1000,
  }).deploymentId, 'healthy');
}

{
  const scheduler = createLogicalScheduler();
  const req = request({ maxInflight: 1 });
  const first = scheduler.enter(req);
  assert.ok(first);
  assert.equal(scheduler.enter(req), null);
  first.release();
  assert.ok(scheduler.enter(req));
}

{
  const scheduler = createLogicalScheduler();
  const deployments = [
    deployment({ deploymentId: 'a', keyIndex: 0 }),
    deployment({ deploymentId: 'b', keyIndex: 1 }),
  ];
  const selected = scheduler.select({
    request: request(),
    deployments,
    now: 1000,
    excludedPairs: new Set([pairId('a', 'strong')]),
  });
  assert.equal(selected.deploymentId, 'b');
}

{
  const scheduler = createLogicalScheduler();
  const req = request({
    candidates: ['strong', 'other'],
    candidateStrategy: 'ordered',
  });
  const deployments = [
    deployment({ deploymentId: 'strong-a', model: 'strong', keyIndex: 0 }),
    deployment({ deploymentId: 'strong-b', model: 'strong', keyIndex: 1 }),
    deployment({ deploymentId: 'other-a', model: 'other', keyIndex: 2 }),
  ];
  const first = selectLogicalCandidate({
    scheduler,
    request: req,
    deployments,
    now: 1000,
    sessionId: '',
    avoidModel: '',
    excludedPairs: new Set(),
    remainingMs: 5000,
    modelAttemptCounts: new Map(),
  });
  assert.equal(first.deploymentId, 'strong-a');

  const second = selectLogicalCandidate({
    scheduler,
    request: req,
    deployments,
    now: 1000,
    sessionId: '',
    avoidModel: '',
    excludedPairs: new Set([pairId('strong-a', 'strong')]),
    remainingMs: 5000,
    modelAttemptCounts: new Map([['strong', 1]]),
  });
  assert.equal(
    second.deploymentId,
    'other-a',
    'ordered routing must give the next model a turn before retrying another deployment of the first model',
  );

  const third = selectLogicalCandidate({
    scheduler,
    request: req,
    deployments,
    now: 1000,
    sessionId: '',
    avoidModel: '',
    excludedPairs: new Set([
      pairId('strong-a', 'strong'),
      pairId('other-a', 'other'),
    ]),
    remainingMs: 5000,
    modelAttemptCounts: new Map([['strong', 1], ['other', 1]]),
  });
  assert.equal(
    third.deploymentId,
    'strong-b',
    'ordered routing may retry another deployment after every eligible model completed the prior round',
  );
}

{
  const scheduler = createLogicalScheduler();
  const deployments = [
    deployment({ deploymentId: 'fast', model: 'strong', initialLatencyMs: 100 }),
    deployment({ deploymentId: 'slow', model: 'other', keyIndex: 1, initialLatencyMs: 5000 }),
  ];
  const common = {
    scheduler,
    deployments,
    now: 1000,
    sessionId: '',
    avoidModel: '',
    excludedPairs: new Set(),
    remainingMs: 5000,
    modelAttemptCounts: new Map([['strong', 3], ['other', 0]]),
  };
  const adaptive = selectLogicalCandidate({
    ...common,
    request: request({ candidates: ['strong', 'other'], candidateStrategy: 'adaptive' }),
  });
  assert.equal(adaptive.deploymentId, 'fast');

  const fair = selectLogicalCandidate({
    ...common,
    request: request({ candidates: ['strong', 'other'], candidateStrategy: 'fair' }),
  });
  assert.equal(fair.deploymentId, 'slow', 'fair routing must still balance model attempts');
}

{
  const scheduler = createLogicalScheduler();
  for (const latencyMs of [9000, 10000, 11000]) {
    scheduler.record({ deploymentId: 'slow', model: 'strong', valid: true, latencyMs, firstByteMs: 100, now: 100 });
  }
  for (const latencyMs of [500, 600, 700]) {
    scheduler.record({ deploymentId: 'fast', model: 'strong', valid: true, latencyMs, firstByteMs: 100, now: 100 });
  }
  const selected = scheduler.select({
    request: request(),
    deployments: [
      deployment({ deploymentId: 'slow', keyIndex: 0 }),
      deployment({ deploymentId: 'fast', keyIndex: 1 }),
    ],
    now: 1000,
  });
  assert.equal(selected.deploymentId, 'fast');
}

{
  const scheduler = createLogicalScheduler();
  scheduler.record({ deploymentId: 'a', model: 'strong', valid: false, latencyMs: 100, failureClass: 'empty_content', now: 100 });
  const selected = scheduler.select({
    request: request(),
    deployments: [
      deployment({ deploymentId: 'a', keyIndex: 0 }),
      deployment({ deploymentId: 'b', keyIndex: 1 }),
    ],
    now: 1000,
  });
  assert.equal(selected.deploymentId, 'b');
}

{
  const scheduler = createLogicalScheduler();
  const req = request({ candidates: ['strong', 'other'] });
  const deployments = [
    deployment({ deploymentId: 'a', model: 'strong', keyIndex: 0 }),
    deployment({ deploymentId: 'b', model: 'other', keyIndex: 1 }),
  ];
  assert.equal(scheduler.select({ request: req, deployments, now: 1000, avoidModel: 'strong' }).model, 'other');
  assert.equal(scheduler.select({ request: req, deployments: [deployments[0]], now: 1000, avoidModel: 'strong' }).model, 'strong');
}

{
  const scheduler = createLogicalScheduler();
  scheduler.record({
    deploymentId: 'a',
    model: 'strong',
    valid: true,
    latencyMs: 1000,
    sessionId: 'session-1',
    now: 100,
  });
  const req = request({ candidates: ['strong', 'other'], sessionAffinity: true });
  const selected = scheduler.select({
    request: req,
    deployments: [
      deployment({ deploymentId: 'a', model: 'strong', keyIndex: 0 }),
      deployment({ deploymentId: 'b', model: 'other', keyIndex: 1, initialLatencyMs: 900 }),
    ],
    sessionId: 'session-1',
    now: 1000,
  });
  assert.equal(selected.model, 'strong');
  const unhealthy = scheduler.select({
    request: req,
    deployments: [
      deployment({ deploymentId: 'a', model: 'strong', keyIndex: 0, badUntil: 2000 }),
      deployment({ deploymentId: 'b', model: 'other', keyIndex: 1 }),
    ],
    sessionId: 'session-1',
    now: 1000,
  });
  assert.equal(unhealthy.model, 'other');
}

{
  const scheduler = createLogicalScheduler();
  const protectedRequest = request({
    logicalModel: 'classifier',
    taskName: 'classification',
    protected: true,
    minReadySlots: 1,
  });
  const lease = scheduler.enter(protectedRequest);
  const ordinary = request({ qualityTier: '', allowWeakFallback: true });
  const deployments = [
    deployment({ deploymentId: 'strong-last', model: 'strong', cap: 1, modelMaxInflight: 1, baseWeight: 10 }),
    deployment({ deploymentId: 'standard', keyIndex: 1, model: 'weak', qualityTier: 'standard', baseWeight: 1 }),
  ];
  assert.equal(scheduler.select({ request: ordinary, deployments, now: 1000 }).deploymentId, 'standard');
  lease.release();
  assert.equal(scheduler.select({ request: ordinary, deployments, now: 1000 }).deploymentId, 'strong-last');
}

console.log('All logical-scheduler tests passed.');
