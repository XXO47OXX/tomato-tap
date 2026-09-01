import assert from 'node:assert/strict';
import { CLAIM_LEASE_MS, createQuotaWindowManager } from '../src/providers/quota/quota-window.mjs';

const OPEN_POLICY = Object.freeze({
  initialState: 'open',
  probeModel: 'model-open',
  probeIntervalMs: 300_000,
  boostWindowMs: 18_000_000,
  boostWeight: 4,
  probeMaxTokens: 128,
});
const CLOSED_POLICY = Object.freeze({
  ...OPEN_POLICY,
  initialState: 'closed',
  probeModel: 'model-closed',
  probeMaxTokens: 256,
});

function deployments() {
  return [
    { deploymentId: 'plain', quotaPolicy: null },
    { deploymentId: 'open', quotaPolicy: OPEN_POLICY },
    { deploymentId: 'closed', quotaPolicy: CLOSED_POLICY },
  ];
}

{
  const manager = createQuotaWindowManager({ deployments: deployments(), persisted: null, now: 1_000 });
  assert.equal(manager.canDispatch('plain', 1_000), true);
  assert.equal(manager.weightMultiplier('plain', 1_000), 1);
  assert.equal(manager.canDispatch('open', 1_000), true);
  assert.equal(manager.canDispatch('closed', 1_000), false);

  const [claim] = manager.claimDueProbes(1_000, 4);
  assert.equal(claim.deploymentId, 'closed');
  assert.equal(typeof claim.claimToken, 'string');
  assert.equal(claim.probeModel, 'model-closed');
  assert.equal(claim.probeMaxTokens, 256);
  assert.equal('value' in claim, false);
  assert.equal(manager.canDispatch('closed', 1_000), false);
  assert.deepEqual(manager.claimDueProbes(1_000, 4), []);

  assert.equal(manager.recordProbeResult({
    deploymentId: 'closed',
    claimToken: claim.claimToken,
    valid: true,
    status: 200,
    quotaSignal: null,
    observedAt: 1_200,
  }), true);
  assert.equal(manager.canDispatch('closed', 1_200), true);
  assert.equal(manager.weightMultiplier('closed', 1_200), 4);
  const opened = manager.snapshot().find((entry) => entry.deploymentId === 'closed');
  assert.equal(opened.state, 'boosted');
  assert.equal(opened.openedAt, 1_200);
  assert.equal(opened.boostedUntil, 18_001_200);
  assert.equal(opened.nextProbeAt, 0);
  assert.equal(opened.consecutiveProbeFailures, 0);

  manager.advance(18_001_201);
  assert.equal(manager.snapshot().find((entry) => entry.deploymentId === 'closed').state, 'open');
  assert.equal(manager.weightMultiplier('closed', 18_001_201), 1);
}

{
  const manager = createQuotaWindowManager({
    deployments: [{ deploymentId: 'closed', quotaPolicy: CLOSED_POLICY }],
    persisted: null,
    now: 1_000,
  });
  const first = manager.claimDueProbes(1_000, 1)[0];
  assert(first);
  assert.deepEqual(manager.claimDueProbes(1_000 + CLAIM_LEASE_MS - 1, 1), []);
  const reclaimed = manager.claimDueProbes(1_000 + CLAIM_LEASE_MS, 1)[0];
  assert.equal(reclaimed.deploymentId, 'closed');
  assert.notEqual(reclaimed.claimToken, first.claimToken);
}

{
  const manager = createQuotaWindowManager({
    deployments: [{ deploymentId: 'open', quotaPolicy: OPEN_POLICY }],
    persisted: null,
    now: 10_000,
  });
  assert.equal(manager.recordRequestResult({
    deploymentId: 'open',
    status: 200,
    quotaSignal: null,
    observedAt: 10_100,
  }), false);
  assert.equal(manager.canDispatch('open', 10_100), true);

  assert.equal(manager.recordRequestResult({
    deploymentId: 'open',
    status: 429,
    quotaSignal: { matched: true, label: 'known', retryAfterMs: 12_000 },
    observedAt: 10_200,
  }), true);
  const known = manager.snapshot().find((entry) => entry.deploymentId === 'open');
  assert.equal(known.state, 'closed');
  assert.equal(known.closedReason, 'known');
  assert.equal(known.nextProbeAt, 22_200);

  assert.deepEqual(manager.claimDueProbes(22_199, 1), []);
  const [claim] = manager.claimDueProbes(22_200, 1);
  assert.equal(claim.deploymentId, 'open');
  assert.equal(manager.recordProbeResult({
    deploymentId: 'open',
    claimToken: claim.claimToken,
    valid: false,
    status: 403,
    quotaSignal: { matched: true, label: 'unknown', retryAfterMs: null },
    observedAt: 22_300,
  }), true);
  const failed = manager.snapshot().find((entry) => entry.deploymentId === 'open');
  assert.equal(failed.state, 'closed');
  assert.equal(failed.nextProbeAt, 322_300);
  assert.equal(failed.lastProbeStatus, 403);
  assert.equal(failed.consecutiveProbeFailures, 1);

  assert.equal(manager.recordProbeResult({
    deploymentId: 'open',
    claimToken: claim.claimToken,
    valid: true,
    status: 200,
    quotaSignal: null,
    observedAt: 22_400,
  }), false);
  assert.equal(manager.canDispatch('open', 22_400), false);
}

{
  const manager = createQuotaWindowManager({
    deployments: deployments(),
    persisted: {
      corrupt: false,
      windows: [{
        deploymentId: 'open',
        state: 'boosted',
        closedReason: '',
        closedAt: 0,
        nextProbeAt: 0,
        openedAt: 50,
        boostedUntil: 500,
        lastProbeStatus: 200,
        consecutiveProbeFailures: 0,
      }],
    },
    now: 100,
  });
  assert.equal(manager.canDispatch('open', 100), true);
  assert.equal(manager.weightMultiplier('open', 100), 4);
}

{
  const manager = createQuotaWindowManager({
    deployments: [{ deploymentId: 'open', quotaPolicy: OPEN_POLICY }],
    persisted: {
      corrupt: false,
      windows: [{
        deploymentId: 'open',
        state: 'half_open',
        closedReason: '',
        closedAt: 0,
        nextProbeAt: 0,
        openedAt: 0,
        boostedUntil: 0,
        lastProbeStatus: 0,
        consecutiveProbeFailures: 0,
      }],
    },
    now: 77,
  });
  assert.equal(manager.canDispatch('open', 77), false);
  assert.equal(manager.claimDueProbes(77, 1)[0].deploymentId, 'open');
}

{
  const persistedWindow = (deploymentId, consecutiveProbeFailures, nextProbeAt) => ({
    deploymentId,
    state: 'closed',
    closedReason: 'probe_failed',
    closedAt: 1,
    nextProbeAt,
    openedAt: 0,
    boostedUntil: 0,
    lastProbeStatus: 500,
    consecutiveProbeFailures,
  });
  const manager = createQuotaWindowManager({
    deployments: [
      { deploymentId: 'legacy-dead', quotaPolicy: CLOSED_POLICY },
      { deploymentId: 'fresh', quotaPolicy: CLOSED_POLICY },
    ],
    persisted: {
      corrupt: false,
      windows: [
        persistedWindow('legacy-dead', 1000, 1),
        persistedWindow('fresh', 0, 100),
      ],
    },
    now: 1_000,
  });
  assert.equal(manager.claimDueProbes(1_000, 1)[0].deploymentId, 'fresh');
}

{
  const manager = createQuotaWindowManager({
    deployments: deployments(),
    persisted: { corrupt: true, windows: [] },
    now: 5_000,
  });
  assert.equal(manager.canDispatch('open', 5_000), false);
  assert.equal(manager.canDispatch('closed', 5_000), false);
  const windows = manager.snapshot();
  assert.equal(windows.every((entry) => entry.state === 'closed'), true);
}

console.log('All quota-window tests passed.');
