// Retry accounting scoped to one vendor/model route.

export function routeCandidateIndexes(
  keyPool,
  { vendor = '', requestedModel = '', format = '', runtimeAvailable = () => true } = {},
) {
  const indexes = [];
  for (let i = 0; i < keyPool.length; i++) {
    const key = keyPool[i];
    if (vendor && key.vendor !== vendor) continue;
    if (format && key.apiFormats instanceof Set && !key.apiFormats.has(format)) continue;
    if (requestedModel && key.modelSet instanceof Set && !key.modelSet.has(requestedModel)) continue;
    if (!runtimeAvailable(key, i)) continue;
    indexes.push(i);
  }
  return indexes;
}

export function routeTriedCount(indexes, excluded) {
  if (!(excluded instanceof Set)) return 0;
  return indexes.reduce((count, index) => count + (excluded.has(index) ? 1 : 0), 0);
}

// Only short 429 cooldowns are eligible for in-request waiting.
export function nextRoute429Recovery(indexes, states, {
  now = Date.now(),
  maxWaitMs = 0,
} = {}) {
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) return null;
  let selected = null;
  for (const keyIndex of indexes) {
    const state = states[keyIndex];
    if (!state || state.cooldownReason !== 'quota_429' || state.badUntil <= now) continue;
    const delayMs = Math.max(1, Math.ceil(state.badUntil - now));
    if (delayMs > maxWaitMs) continue;
    if (!selected || delayMs < selected.delayMs) selected = { keyIndex, delayMs };
  }
  return selected;
}
