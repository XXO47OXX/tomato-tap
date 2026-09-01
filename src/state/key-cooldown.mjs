const TRANSIENT_REASONS = new Set(['mixed_error', 'upstream_5xx']);
const PROTECTED_REASONS = new Set([
  'quota_429',
  'auth_401',
  'forbidden_403',
  'proxy_transport',
]);

export function countsTowardMixedError(status, { modelScoped403 = false } = {}) {
  const code = Number(status);
  if (!Number.isFinite(code) || code === 0 || code === 429) return false;
  if (code === 403 && modelScoped403) return false;
  return code < 200 || code >= 300;
}

export function advanceMixedErrorStreak(
  current,
  status,
  { modelScoped403 = false } = {},
) {
  if (!countsTowardMixedError(status, { modelScoped403 })) return 0;
  return Math.max(0, Number(current) || 0) + 1;
}

export function setKeyCooldown(state, reason, untilMs) {
  if (!state || !Number.isFinite(untilMs) || untilMs <= 0) return;
  const currentProtected = PROTECTED_REASONS.has(state.cooldownReason);
  const nextProtected = PROTECTED_REASONS.has(reason);
  state.badUntil = Math.max(Number(state.badUntil) || 0, untilMs);
  if (!currentProtected || nextProtected) state.cooldownReason = reason;
}

export function recoverTransientCooldown(state, nowMs = Date.now()) {
  if (!state || (Number(state.badUntil) || 0) <= nowMs) {
    if (state) state.cooldownReason = null;
    return false;
  }
  if (!TRANSIENT_REASONS.has(state.cooldownReason)) return false;
  state.badUntil = 0;
  state.cooldownReason = null;
  return true;
}

export function activeCooldownReason(state, nowMs = Date.now()) {
  if (!state || (Number(state.badUntil) || 0) <= nowMs) {
    if (state) state.cooldownReason = null;
    return null;
  }
  return state.cooldownReason || null;
}

// Persist active cooldowns by runtime key fingerprint.
export function exportCooldownRecords(keyStates, keyOf, now = Date.now()) {
  const records = {};
  for (let i = 0; i < keyStates.length; i++) {
    const state = keyStates[i];
    const until = Number(state?.badUntil) || 0;
    if (until <= now) continue;
    const id = keyOf(i);
    if (!id) continue;
    records[id] = { badUntil: until, reason: state.cooldownReason || null };
  }
  return records;
}

// Ignore expired, unknown, or malformed records during restore.
export function applyCooldownRecords(records, keyStates, keyOf, now = Date.now()) {
  let applied = 0;
  if (!records || typeof records !== 'object' || Array.isArray(records)) return applied;
  for (let i = 0; i < keyStates.length; i++) {
    const record = records[keyOf(i)];
    const until = Number(record?.badUntil) || 0;
    if (until <= now) continue;
    setKeyCooldown(keyStates[i], String(record.reason || 'persisted'), until);
    applied++;
  }
  return applied;
}
