export const ELIGIBILITY_STATES = Object.freeze([
  'disabled',
  'missing_credential',
  'expired',
  'blocked',
  'cooldown',
  'congested',
  'probing',
  'unhealthy',
  'ready',
]);

const TERMINAL_STATES = new Set(['disabled', 'missing_credential', 'expired']);
const DISPATCHABLE_STATES = new Set(['probing', 'unhealthy', 'ready']);

export function evaluateCandidate(input = {}, now = Date.now()) {
  const configured = input.configured !== false;
  const reasons = [];
  const recoveryTimes = [];
  const addRecovery = (value) => {
    const timestamp = finiteTimestamp(value);
    if (timestamp > now) recoveryTimes.push(timestamp);
  };

  let state = 'ready';
  let reason = 'validated';

  if (!configured || input.disabled === true) {
    state = 'disabled';
    reason = 'deployment_disabled';
  } else if (input.credentialPresent === false) {
    state = 'missing_credential';
    reason = 'missing_credential';
  } else if (finiteTimestamp(input.expiresAt) > 0 && finiteTimestamp(input.expiresAt) <= now) {
    state = 'expired';
    reason = 'credential_expired';
  } else if (input.vendorBlockedReason || input.pricingBlockedReason) {
    state = 'blocked';
    reason = input.vendorBlockedReason ? 'vendor_blocked' : 'pricing_blocked';
    reasons.push(String(input.vendorBlockedReason || input.pricingBlockedReason));
    addRecovery(input.vendorRecoveryAt);
  } else {
    const cooldowns = [];
    if (input.proxyAvailable === false) {
      cooldowns.push({ reason: 'proxy_unavailable', at: input.proxyRecoveryAt });
    }
    if (input.quotaState === 'closed' || input.quotaState === 'half_open') {
      cooldowns.push({
        reason: input.quotaState === 'half_open' ? 'quota_probing' : 'quota_closed',
        at: input.quotaNextProbeAt,
      });
    }
    if (finiteTimestamp(input.keyCooldownUntil) > now) {
      cooldowns.push({ reason: input.keyCooldownReason || 'key_cooldown', at: input.keyCooldownUntil });
    }
    if (finiteTimestamp(input.modelCooldownUntil) > now) {
      cooldowns.push({ reason: input.modelCooldownReason || 'model_cooldown', at: input.modelCooldownUntil });
    }
    if (finiteTimestamp(input.rateLimitUntil) > now) {
      cooldowns.push({ reason: 'rate_limit_window', at: input.rateLimitUntil });
    }
    if (input.latestValidatedOutcome === false
        && finiteTimestamp(input.qualificationNextProbeAt) > now) {
      cooldowns.push({
        reason: 'qualification_backoff',
        at: input.qualificationNextProbeAt,
      });
    }
    if (cooldowns.length > 0) {
      state = 'cooldown';
      reason = cooldowns[0].reason;
      for (const cooldown of cooldowns) {
        reasons.push(cooldown.reason);
        addRecovery(cooldown.at);
      }
    } else if (input.logicalAdmissionFull === true
        || input.vendorCapacityFull === true
        || input.keyCapacityFull === true
        || input.modelCapacityFull === true) {
      state = 'congested';
      if (input.logicalAdmissionFull === true) reason = 'logical_capacity';
      else if (input.vendorCapacityFull === true) reason = 'vendor_capacity';
      else if (input.keyCapacityFull === true) reason = 'key_capacity';
      else reason = 'model_capacity';
    } else if (input.latestValidatedOutcome === false) {
      // A failed pair becomes dispatchable again only when its qualification
      // backoff expires. Calling the due state "probing" makes clear that it
      // has not recovered until a validated response succeeds.
      state = 'probing';
      reason = 'revalidation_due';
      reasons.push(input.failureClass || 'validation_failed');
    } else if (input.latestValidatedOutcome !== true) {
      state = 'probing';
      reason = 'not_yet_validated';
    }
  }

  const recoveryAt = recoveryTimes.length > 0 ? Math.max(...recoveryTimes) : 0;
  return Object.freeze({
    configured,
    state,
    reason,
    reasons: Object.freeze([...new Set(reasons.length ? reasons : [reason])]),
    dispatchable: DISPATCHABLE_STATES.has(state),
    available: state === 'ready',
    retryable: !TERMINAL_STATES.has(state),
    recoveryAt,
    recovery_at: recoveryAt > 0 ? new Date(recoveryAt).toISOString() : null,
    lastValidatedAt: finiteTimestamp(input.lastValidatedAt),
  });
}

export function summarizeEligibility(records, now = Date.now()) {
  const counts = Object.fromEntries(ELIGIBILITY_STATES.map((state) => [state, 0]));
  let dispatchable = 0;
  let available = 0;
  let nextRecoveryAt = 0;
  for (const record of records || []) {
    const eligibility = record?.eligibility || record;
    if (!eligibility || !Object.hasOwn(counts, eligibility.state)) continue;
    counts[eligibility.state]++;
    if (eligibility.dispatchable) dispatchable++;
    if (eligibility.available) available++;
    const recoveryAt = finiteTimestamp(eligibility.recoveryAt);
    if (recoveryAt > now && (nextRecoveryAt === 0 || recoveryAt < nextRecoveryAt)) {
      nextRecoveryAt = recoveryAt;
    }
  }
  const health = counts.ready > 0
    ? 'available'
    : counts.congested > 0
      ? 'congested'
      : counts.probing > 0
        ? 'probing'
        : 'unavailable';
  const state = counts.ready > 0
    ? 'ready'
    : counts.congested > 0
      ? 'congested'
      : counts.probing > 0
        ? 'probing'
        : counts.cooldown > 0
          ? 'cooldown'
          : counts.unhealthy > 0
            ? 'unhealthy'
            : counts.blocked > 0
              ? 'blocked'
              : counts.expired > 0
                ? 'expired'
                : counts.missing_credential > 0
                  ? 'missing_credential'
                  : 'disabled';
  return Object.freeze({
    health,
    state,
    configured: (records || []).length,
    dispatchable,
    available,
    counts: Object.freeze(counts),
    nextRecoveryAt,
    next_recovery_at: nextRecoveryAt > 0 ? new Date(nextRecoveryAt).toISOString() : null,
  });
}

export function nextEligibilityRetryDelay(records, now, deadlineAt, shortRetryMs = 50) {
  const remainingMs = Number(deadlineAt) - Number(now);
  if (!(remainingMs > 0)) return 0;
  let retrySoon = false;
  let earliestRecoveryAt = 0;
  for (const record of records || []) {
    const eligibility = record?.eligibility || record;
    if (!eligibility || eligibility.retryable !== true) continue;
    if (eligibility.state === 'congested' || eligibility.state === 'probing') {
      retrySoon = true;
      continue;
    }
    const recoveryAt = finiteTimestamp(eligibility.recoveryAt);
    if (recoveryAt > now && recoveryAt < deadlineAt) {
      if (earliestRecoveryAt === 0 || recoveryAt < earliestRecoveryAt) {
        earliestRecoveryAt = recoveryAt;
      }
    }
  }
  if (earliestRecoveryAt > 0) return Math.max(10, Math.min(earliestRecoveryAt - now, remainingMs));
  if (retrySoon) return Math.max(10, Math.min(shortRetryMs, remainingMs));
  return 0;
}

export function createCandidateQualificationRegistry({
  historySize = 16,
  failureBackoffBaseMs = 30_000,
  failureBackoffMaxMs = 15 * 60_000,
} = {}) {
  if (!Number.isInteger(historySize) || historySize < 1) {
    throw new Error('candidate qualification historySize must be a positive integer');
  }
  if (!Number.isFinite(failureBackoffBaseMs) || failureBackoffBaseMs < 1) {
    throw new Error('candidate qualification failureBackoffBaseMs must be positive');
  }
  if (!Number.isFinite(failureBackoffMaxMs)
      || failureBackoffMaxMs < failureBackoffBaseMs) {
    throw new Error(
      'candidate qualification failureBackoffMaxMs must be at least failureBackoffBaseMs',
    );
  }
  const records = new Map();

  function record({
    deploymentId,
    model,
    valid,
    failureClass = '',
    latencyMs = 0,
    firstByteMs = 0,
    identity = '',
    now = Date.now(),
  }) {
    const id = qualificationId(deploymentId, model);
    if (!id) return null;
    const previous = records.get(id);
    const outcomes = [...(previous?.outcomes || []), valid === true ? 1 : 0];
    if (outcomes.length > historySize) outcomes.splice(0, outcomes.length - historySize);
    const consecutiveFailures = valid === true
      ? 0
      : (previous?.latestValidatedOutcome === false
          ? (previous.consecutiveFailures || 1) + 1
          : 1);
    const nextProbeAt = valid === true
      ? 0
      : finiteTimestamp(now) + qualificationBackoffMs(
          consecutiveFailures,
          failureBackoffBaseMs,
          failureBackoffMaxMs,
        );
    const next = Object.freeze({
      deploymentId: String(deploymentId),
      model: String(model),
      latestValidatedOutcome: valid === true,
      failureClass: valid === true ? '' : String(failureClass || 'validation_failed'),
      lastValidatedAt: finiteTimestamp(now) || Date.now(),
      consecutiveFailures,
      nextProbeAt,
      latencyMs: Math.max(0, Number(latencyMs) || 0),
      firstByteMs: Math.max(0, Number(firstByteMs) || 0),
      identity: String(identity || ''),
      outcomes: Object.freeze(outcomes),
    });
    records.set(id, next);
    return next;
  }

  function get(deploymentId, model) {
    return records.get(qualificationId(deploymentId, model)) || null;
  }

  function reconcile(activePairs) {
    const before = records.size;
    const active = new Map(
      [...(activePairs || [])]
        .map((pair) => [
          qualificationId(pair?.deploymentId, pair?.model),
          String(pair?.identity || ''),
        ])
        .filter(([id]) => Boolean(id)),
    );
    for (const [id, value] of records) {
      const activeIdentity = active.get(id);
      if (!active.has(id)
          || (value.identity && activeIdentity && value.identity !== activeIdentity)) {
        records.delete(id);
      }
    }
    return records.size !== before;
  }

  function hydrate(serialized, { now = Date.now(), maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
    for (const value of Array.isArray(serialized) ? serialized : []) {
      const validatedAt = finiteTimestamp(value?.lastValidatedAt);
      if (!validatedAt || validatedAt > now || now - validatedAt > maxAgeMs) continue;
      const id = qualificationId(value?.deploymentId, value?.model);
      if (!id) continue;
      const outcomes = (Array.isArray(value.outcomes) ? value.outcomes : [])
        .map((outcome) => outcome === 1 ? 1 : 0)
        .slice(-historySize);
      records.set(id, Object.freeze({
        deploymentId: String(value.deploymentId),
        model: String(value.model),
        latestValidatedOutcome: value.latestValidatedOutcome === true,
        failureClass: value.latestValidatedOutcome === true
          ? ''
          : String(value.failureClass || 'validation_failed'),
        lastValidatedAt: validatedAt,
        consecutiveFailures: value.latestValidatedOutcome === true
          ? 0
          : Math.max(1, Number(value.consecutiveFailures) || 1),
        nextProbeAt: value.latestValidatedOutcome === true
          ? 0
          : finiteTimestamp(value.nextProbeAt),
        latencyMs: Math.max(0, Number(value.latencyMs) || 0),
        firstByteMs: Math.max(0, Number(value.firstByteMs) || 0),
        identity: String(value.identity || ''),
        outcomes: Object.freeze(outcomes),
      }));
    }
    return records.size;
  }

  function exportState() {
    return [...records.values()].map((value) => ({
      deploymentId: value.deploymentId,
      model: value.model,
      latestValidatedOutcome: value.latestValidatedOutcome,
      failureClass: value.failureClass,
      lastValidatedAt: value.lastValidatedAt,
      consecutiveFailures: value.consecutiveFailures,
      nextProbeAt: value.nextProbeAt,
      latencyMs: value.latencyMs,
      firstByteMs: value.firstByteMs,
      identity: value.identity,
      outcomes: [...value.outcomes],
    }));
  }

  function snapshot() {
    return [...records.values()]
      .map((value) => ({
        deployment: value.deploymentId,
        model: value.model,
        valid: value.latestValidatedOutcome,
        failure_class: value.failureClass || null,
        last_validated_at: value.lastValidatedAt,
        consecutive_failures: value.consecutiveFailures,
        next_probe_at: value.nextProbeAt > 0
          ? new Date(value.nextProbeAt).toISOString()
          : null,
        latency_ms: value.latencyMs,
        first_byte_ms: value.firstByteMs,
        recent_successes: value.outcomes.reduce((sum, outcome) => sum + outcome, 0),
        recent_attempts: value.outcomes.length,
      }))
      .sort((left, right) => (
        left.deployment.localeCompare(right.deployment)
        || left.model.localeCompare(right.model)
      ));
  }

  return Object.freeze({ record, get, reconcile, hydrate, exportState, snapshot });
}

function qualificationId(deploymentId, model) {
  const deployment = String(deploymentId || '').trim();
  const normalizedModel = String(model || '').trim().toLowerCase();
  return deployment && normalizedModel ? `${deployment}\u0000${normalizedModel}` : '';
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function qualificationBackoffMs(failures, baseMs, maxMs) {
  const exponent = Math.max(0, Math.min(30, failures - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}
