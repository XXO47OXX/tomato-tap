export function createRuntimeGenerationManager({
  initialRevision,
  initialAppliedAt = Date.now(),
  prepare,
  activate,
  isIdle = () => true,
  logger = console,
} = {}) {
  if (typeof prepare !== 'function') throw new Error('runtime generation requires prepare');
  if (typeof activate !== 'function') throw new Error('runtime generation requires activate');
  let activeRequests = 0;
  let pending = null;
  let applying = false;
  const activationWaiters = new Set();
  const state = {
    active_revision: String(initialRevision || ''),
    pending_revision: null,
    last_applied_at: initialAppliedAt,
    last_error_at: null,
    last_error: null,
    reload_count: 0,
  };

  async function stage(candidate) {
    const prepared = await prepare(candidate);
    pending = { candidate, prepared, stagedAt: Date.now() };
    state.pending_revision = candidate.revision;
    tryActivate();
  }

  function tryActivate() {
    if (!pending || applying || activeRequests > 0 || !isIdle()) return false;
    applying = true;
    try {
      const next = pending;
      activate(next.candidate, next.prepared);
      pending = null;
      state.active_revision = next.candidate.revision;
      state.pending_revision = null;
      state.last_applied_at = Date.now();
      state.last_error_at = null;
      state.last_error = null;
      state.reload_count++;
      logger.log?.(`[config-reload] activated revision=${next.candidate.revision}`);
      settleActivationWaiters(true);
      return true;
    } catch (error) {
      recordError(error);
      logger.error?.(`[config-reload] activation failed: ${state.last_error}`);
      return false;
    } finally {
      applying = false;
    }
  }

  function trackResponse(response) {
    activeRequests++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      tryActivate();
    };
    response.once('finish', release);
    response.once('close', release);
    return release;
  }

  function recordError(error) {
    state.last_error_at = Date.now();
    state.last_error = sanitizeError(error);
  }

  function waitForActivation(timeoutMs = 5_000) {
    if (!pending && !applying) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (activated) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activationWaiters.delete(waiter);
        resolve(activated);
      };
      const timer = setTimeout(() => waiter(false), Math.max(1, Number(timeoutMs) || 5_000));
      activationWaiters.add(waiter);
    });
  }

  function settleActivationWaiters(activated) {
    for (const waiter of [...activationWaiters]) waiter(activated);
  }

  function status() {
    return {
      ...state,
      active_requests: activeRequests,
      waiting_requests: activationWaiters.size,
      applying,
      pending_since: pending?.stagedAt || null,
    };
  }

  return Object.freeze({
    stage,
    tryActivate,
    trackResponse,
    waitForActivation,
    recordError,
    status,
  });
}

function sanitizeError(error) {
  return String(error?.message || error || 'runtime activation failed')
    .replace(/(sk|tp|ark|ak)[_-][A-Za-z0-9._-]+/gi, '[redacted]')
    .slice(0, 512);
}
