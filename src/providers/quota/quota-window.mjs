import { randomUUID } from 'node:crypto';

const DISPATCHABLE = new Set(['open', 'boosted']);
export const CLAIM_LEASE_MS = 60_000;

export function createQuotaWindowManager({
  deployments = [],
  persisted = null,
  now = Date.now(),
} = {}) {
  const policies = new Map();
  const windows = new Map();
  const claims = new Map();
  const persistedById = new Map(
    Array.isArray(persisted?.windows)
      ? persisted.windows.map((entry) => [entry.deploymentId, entry])
      : [],
  );

  for (const deployment of deployments) {
    const policy = deployment?.quotaPolicy;
    const deploymentId = deployment?.deploymentId;
    if (!deploymentId || !policy) continue;
    policies.set(deploymentId, policy);
    const saved = persistedById.get(deploymentId);
    windows.set(
      deploymentId,
      persisted?.corrupt
        ? closedWindow(deploymentId, 'corrupt_state', now, now)
        : saved
          ? normalizeWindow(deploymentId, saved, now)
          : policy.initialState === 'open'
            ? openWindow(deploymentId)
            : closedWindow(deploymentId, 'initial_closed', now, now),
    );
  }

  function advance(at = Date.now()) {
    let changed = false;
    for (const window of windows.values()) {
      if (window.state === 'boosted' && window.boostedUntil > 0 && at > window.boostedUntil) {
        window.state = 'open';
        window.boostedUntil = 0;
        changed = true;
      }
      const claim = claims.get(window.deploymentId);
      if (window.state === 'half_open' && claim && claim.expiresAt <= at) {
        claims.delete(window.deploymentId);
        window.state = 'closed';
        window.closedReason = 'probe_lease_expired';
        if (window.closedKind !== 'quota') window.closedKind = 'probe_failure';
        window.closedAt = at;
        window.nextProbeAt = at;
        window.consecutiveProbeFailures++;
        changed = true;
      }
    }
    return changed;
  }

  function canDispatch(deploymentId, at = Date.now()) {
    if (!policies.has(deploymentId)) return true;
    advance(at);
    return DISPATCHABLE.has(windows.get(deploymentId).state);
  }

  function status(deploymentId, at = Date.now()) {
    if (!policies.has(deploymentId)) {
      return { deploymentId, managed: false, state: 'open', closedKind: '' };
    }
    advance(at);
    return { ...windows.get(deploymentId), managed: true };
  }

  function weightMultiplier(deploymentId, at = Date.now()) {
    if (!policies.has(deploymentId)) return 1;
    advance(at);
    return windows.get(deploymentId).state === 'boosted'
      ? policies.get(deploymentId).boostWeight
      : 1;
  }

  function claimDueProbes(at = Date.now(), limit = 1) {
    advance(at);
    const output = [];
    const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    // Probe lower-failure deployments first; break ties by recency and ID.
    const due = [...windows.entries()]
      .filter(([, window]) => window.state === 'closed' && window.nextProbeAt <= at)
      .sort((left, right) => (
        left[1].consecutiveProbeFailures - right[1].consecutiveProbeFailures
        || right[1].nextProbeAt - left[1].nextProbeAt
        || left[0].localeCompare(right[0])
      ));
    for (const [deploymentId, window] of due) {
      if (output.length >= boundedLimit) break;
      const policy = policies.get(deploymentId);
      const claimToken = randomUUID();
      window.state = 'half_open';
      claims.set(deploymentId, {
        token: claimToken,
        expiresAt: at + CLAIM_LEASE_MS,
      });
      output.push({
        deploymentId,
        claimToken,
        probeModel: policy.probeModel,
        probeMaxTokens: policy.probeMaxTokens,
      });
    }
    return output;
  }

  function recordProbeResult({
    deploymentId,
    claimToken,
    valid,
    status = 0,
    quotaSignal = null,
    observedAt = Date.now(),
  }) {
    const policy = policies.get(deploymentId);
    const window = windows.get(deploymentId);
    if (!policy || !window || window.state !== 'half_open') return false;
    if (!claimToken || claims.get(deploymentId)?.token !== claimToken) return false;
    claims.delete(deploymentId);
    window.lastProbeStatus = Number(status) || 0;
    if (valid) {
      Object.assign(window, {
        state: 'boosted',
        closedReason: '',
        closedKind: '',
        closedAt: 0,
        nextProbeAt: 0,
        openedAt: observedAt,
        boostedUntil: observedAt + policy.boostWindowMs,
        consecutiveProbeFailures: 0,
      });
      return true;
    }
    Object.assign(window, {
      state: 'closed',
      closedReason: quotaSignal?.label || 'probe_failed',
      closedKind: quotaSignal?.matched === true || window.closedKind === 'quota'
        ? 'quota'
        : 'probe_failure',
      closedAt: observedAt,
      nextProbeAt: nextProbeTime(policy, quotaSignal, observedAt),
      openedAt: 0,
      boostedUntil: 0,
      consecutiveProbeFailures: window.consecutiveProbeFailures + 1,
    });
    return true;
  }

  function recordRequestResult({
    deploymentId,
    quotaSignal = null,
    observedAt = Date.now(),
  }) {
    const policy = policies.get(deploymentId);
    const window = windows.get(deploymentId);
    if (!policy || !window || !quotaSignal?.matched) return false;
    claims.delete(deploymentId);
    Object.assign(window, {
      state: 'closed',
      closedReason: quotaSignal.label || 'quota_exhausted',
      closedKind: 'quota',
      closedAt: observedAt,
      nextProbeAt: nextProbeTime(policy, quotaSignal, observedAt),
      openedAt: 0,
      boostedUntil: 0,
    });
    return true;
  }

  function snapshot() {
    return [...windows.values()]
      .map((window) => ({ ...window }))
      .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  }

  return {
    canDispatch,
    status,
    weightMultiplier,
    claimDueProbes,
    recordProbeResult,
    recordRequestResult,
    advance,
    snapshot,
  };
}

function nextProbeTime(policy, quotaSignal, observedAt) {
  const retryAfterMs = Number(quotaSignal?.retryAfterMs);
  return observedAt + (
    Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : policy.probeIntervalMs
  );
}

function openWindow(deploymentId) {
  return {
    deploymentId,
    state: 'open',
    closedReason: '',
    closedKind: '',
    closedAt: 0,
    nextProbeAt: 0,
    openedAt: 0,
    boostedUntil: 0,
    lastProbeStatus: 0,
    consecutiveProbeFailures: 0,
  };
}

function closedWindow(deploymentId, closedReason, closedAt, nextProbeAt) {
  return {
    ...openWindow(deploymentId),
    state: 'closed',
    closedReason,
    closedKind: 'state',
    closedAt,
    nextProbeAt,
  };
}

function normalizeWindow(deploymentId, saved, now) {
  const state = ['open', 'closed', 'half_open', 'boosted'].includes(saved.state)
    ? saved.state
    : 'closed';
  return {
    deploymentId,
    state: state === 'half_open' ? 'closed' : state,
    closedReason: String(saved.closedReason || ''),
    closedKind: normalizeClosedKind(saved.closedKind, saved.closedReason),
    closedAt: finiteNumber(saved.closedAt),
    nextProbeAt: state === 'half_open' ? now : finiteNumber(saved.nextProbeAt),
    openedAt: finiteNumber(saved.openedAt),
    boostedUntil: finiteNumber(saved.boostedUntil),
    lastProbeStatus: finiteNumber(saved.lastProbeStatus),
    consecutiveProbeFailures: finiteNumber(saved.consecutiveProbeFailures),
  };
}

function normalizeClosedKind(value, reason) {
  if (['', 'quota', 'probe_failure', 'state'].includes(value)) return value;
  const normalizedReason = String(reason || '').toLowerCase();
  if (normalizedReason.includes('quota')
      || normalizedReason.includes('usage')
      || normalizedReason.includes('billing-cycle')
      || normalizedReason.includes('5h-window')
      || normalizedReason.includes('exhaust')) return 'quota';
  if (normalizedReason.includes('probe')) return 'probe_failure';
  return normalizedReason ? 'state' : '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
