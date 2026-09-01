import { classify403Scope } from './cooldown-scope.mjs';
import {
  advanceMixedErrorStreak,
  countsTowardMixedError,
  recoverTransientCooldown,
  setKeyCooldown,
} from './key-cooldown.mjs';

export function createInitialKeyState(initialCap) {
  return {
    inflight: 0,
    cap: initialCap,
    badUntil: 0,
    cooldownReason: null,
    deadModels: new Map(),
    consec2xx: 0,
    consec5xx: 0,
    consec403: 0,
    consecErr: 0,
    total403: 0,
    capHistory: [initialCap],
    outcomes: [],
    total2xx: 0,
    total429: 0,
    total401: 0,
    total5xx: 0,
    totalNetErr: 0,
    rateWindowStart: 0,
    rateWindowCount: 0,
    rateLastStartedAt: 0,
  };
}

export function pushCapHistory(state, maxLength = 8) {
  state.capHistory.push(state.cap);
  if (state.capHistory.length > maxLength) state.capHistory.shift();
}

export function applyKeyOutcome({
  state,
  key,
  status,
  retryAfterMs,
  requestedModel,
  capMin,
  capMax,
  auth401CooldownMs,
  now = Date.now(),
  policy,
  logger = console,
}) {
  const p = normalizePolicy(policy);
  state.outcomes.push(status | 0);
  if (state.outcomes.length > p.outcomesLength) state.outcomes.shift();

  if (status >= 200 && status < 300) {
    state.total2xx++;
    state.consec2xx++;
    state.consec5xx = 0;
    state.consec403 = 0;
    state.consecErr = 0;
    recoverTransientCooldown(state);
    if (state.consec2xx >= p.capGrowAfter && state.cap < capMax) {
      state.cap++;
      pushCapHistory(state, p.capHistoryLength);
      state.consec2xx = 0;
    }
    return;
  }

  const modelScoped403 = status === 403
    && classify403Scope({ vendor: key.vendor, requestedModel }) === 'model';
  const mixedErrorEligible = countsTowardMixedError(status, { modelScoped403 });
  state.consecErr = advanceMixedErrorStreak(state.consecErr, status, { modelScoped403 });
  if (mixedErrorEligible && state.consecErr >= p.consecutiveErrorThreshold) {
    setKeyCooldown(state, 'mixed_error', now + p.burstErrorCooldownMs);
    if (state.consecErr === p.consecutiveErrorThreshold) {
      logger.warn?.(`[err-burst] key=${key.name} consec_err=${state.consecErr} → ${Math.round(p.burstErrorCooldownMs / 60000)}min cooldown outcomes=${summarizeOutcomes(state.outcomes)}`);
    }
  }

  if (status === 429) {
    state.total429++;
    state.consec2xx = 0;
    state.consec403 = 0;
    halveCap(state, capMin, p.capHistoryLength);
    const cooldown = retryAfterMs && retryAfterMs > 0
      ? Math.min(retryAfterMs, p.cooldown429MaxMs)
      : p.cooldown429DefaultMs;
    setKeyCooldown(state, 'quota_429', now + cooldown);
  } else if (status === 401) {
    state.total401++;
    state.consec2xx = 0;
    state.consec403 = 0;
    if (state.cap !== capMin) {
      state.cap = capMin;
      pushCapHistory(state, p.capHistoryLength);
    }
    if (auth401CooldownMs > 0) setKeyCooldown(state, 'auth_401', now + auth401CooldownMs);
  } else if (status === 403) {
    state.total403++;
    state.consec2xx = 0;
    if (modelScoped403) {
      state.deadModels.set(requestedModel.toLowerCase(), now + p.model403CooldownMs);
      state.consec403 = 0;
      logger.warn?.(`[403-model] key=${key.name} model="${requestedModel}" → ${Math.round(p.model403CooldownMs / 60000)}min model-only cooldown`);
    } else {
      state.consec403++;
    }
    if (!modelScoped403 && state.consec403 >= p.consecutive403Threshold) {
      setKeyCooldown(state, 'forbidden_403', now + p.cooldown403Ms);
      if (state.consec403 === p.consecutive403Threshold) {
        logger.warn?.(`[403-streak] key=${key.name} consec=${state.consec403} → ${Math.round(p.cooldown403Ms / 60000)}min cooldown outcomes=${summarizeOutcomes(state.outcomes)}`);
      }
    }
  } else if (status >= 500 && status < 600) {
    state.total5xx++;
    state.consec2xx = 0;
    state.consec403 = 0;
    state.consec5xx++;
    halveCap(state, capMin, p.capHistoryLength);
    const persistent = state.consec5xx >= p.consecutive5xxThreshold;
    const cooldown = persistent ? p.persistent5xxCooldownMs : p.cooldown5xxMs;
    setKeyCooldown(state, 'upstream_5xx', now + cooldown);
    if (persistent && state.consec5xx === p.consecutive5xxThreshold) {
      logger.warn?.(`[5xx-penalty] key=${key.name} consec=${state.consec5xx} → ${Math.round(cooldown / 1000)}s cooldown outcomes=${summarizeOutcomes(state.outcomes)}`);
    }
  } else if (status === 0) {
    state.totalNetErr++;
    state.consec2xx = 0;
    state.consec403 = 0;
  } else if ((status === 404 || status === 402) && requestedModel) {
    const model = requestedModel.toLowerCase();
    if (!state.deadModels.has(model)) {
      state.deadModels.set(model, now + p.deadModelCooldownMs);
      logger.warn?.(`[dead-model] key=${key.name} model="${requestedModel}" status=${status} → ${Math.round(p.deadModelCooldownMs / 3600000)}h cooldown for this (key,model) pair`);
    }
    state.consec2xx = 0;
  }
}

export function summarizeOutcomes(outcomes) {
  const counts = {};
  for (const status of outcomes || []) {
    const bucket = status === 0
      ? 'net_err'
      : status >= 200 && status < 300
        ? '2xx'
        : String(status);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([bucket, count]) => `${bucket}×${count}`)
    .join(' ') || '(empty)';
}

function halveCap(state, capMin, historyLength) {
  const next = Math.max(state.cap >> 1, capMin);
  if (next === state.cap) return;
  state.cap = next;
  pushCapHistory(state, historyLength);
}

function normalizePolicy(policy = {}) {
  return {
    outcomesLength: policy.outcomesLength ?? 32,
    capHistoryLength: policy.capHistoryLength ?? 8,
    capGrowAfter: policy.capGrowAfter ?? 4,
    cooldown429DefaultMs: policy.cooldown429DefaultMs ?? 30_000,
    cooldown429MaxMs: policy.cooldown429MaxMs ?? 7 * 24 * 60 * 60 * 1000,
    model403CooldownMs: policy.model403CooldownMs ?? 30 * 60 * 1000,
    cooldown403Ms: policy.cooldown403Ms ?? 60 * 60 * 1000,
    consecutive403Threshold: policy.consecutive403Threshold ?? 3,
    cooldown5xxMs: policy.cooldown5xxMs ?? 60_000,
    persistent5xxCooldownMs: policy.persistent5xxCooldownMs ?? 5 * 60_000,
    consecutive5xxThreshold: policy.consecutive5xxThreshold ?? 3,
    consecutiveErrorThreshold: policy.consecutiveErrorThreshold ?? 8,
    burstErrorCooldownMs: policy.burstErrorCooldownMs ?? 60 * 60 * 1000,
    deadModelCooldownMs: policy.deadModelCooldownMs ?? 24 * 60 * 60 * 1000,
  };
}
