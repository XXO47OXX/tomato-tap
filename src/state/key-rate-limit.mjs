// Per-key RPM admission, independent of AIMD concurrency.

const MINUTE_MS = 60_000;

export function rateLimitStatus(state, policy, now = Date.now()) {
  if (!policy) return { allowed: true, retryAt: 0, remaining: Infinity };
  ensureState(state);

  if (policy.mode === 'paced') {
    const intervalMs = Math.ceil(MINUTE_MS / policy.requestsPerMinute);
    const retryAt = Math.max(0, state.rateLastStartedAt + intervalMs);
    return {
      allowed: state.rateLastStartedAt === 0 || now >= retryAt,
      retryAt: state.rateLastStartedAt === 0 || now >= retryAt ? 0 : retryAt,
      remaining: state.rateLastStartedAt === 0 || now >= retryAt ? 1 : 0,
      intervalMs,
    };
  }

  const windowStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  if (state.rateWindowStart !== windowStart) {
    state.rateWindowStart = windowStart;
    state.rateWindowCount = 0;
  }
  const remaining = Math.max(0, policy.requestsPerMinute - state.rateWindowCount);
  return {
    allowed: remaining > 0,
    retryAt: remaining > 0 ? 0 : windowStart + MINUTE_MS,
    remaining,
    intervalMs: 0,
  };
}

export function consumeRateLimit(state, policy, now = Date.now()) {
  const status = rateLimitStatus(state, policy, now);
  if (!status.allowed) return false;
  if (!policy) return true;
  if (policy.mode === 'paced') state.rateLastStartedAt = now;
  else state.rateWindowCount += 1;
  return true;
}

function ensureState(state) {
  if (!Number.isFinite(state.rateWindowStart)) state.rateWindowStart = 0;
  if (!Number.isFinite(state.rateWindowCount)) state.rateWindowCount = 0;
  if (!Number.isFinite(state.rateLastStartedAt)) state.rateLastStartedAt = 0;
}
