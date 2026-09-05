import { activeCooldownReason } from '../state/key-cooldown.mjs';
import { rateLimitStatus } from '../state/key-rate-limit.mjs';
import { summarizeOutcomes } from '../state/key-state.mjs';

export function providerLabelForKey(key) {
  return String(key?.providerLabel || key?.deploymentId || key?.vendor || 'unknown');
}

export function buildKeyPoolStatus({
  keys,
  states,
  stickyRuntime,
  quotaStatus = () => ({ managed: false }),
  exposeUpstreamHosts = false,
  now = Date.now(),
}) {
  if (!Array.isArray(keys) || !Array.isArray(states) || keys.length !== states.length) {
    throw new TypeError('key-pool status requires aligned key and state arrays');
  }

  return keys.map((key, index) => {
    const state = states[index];
    const entry = {
      name: key.name,
      deployment: key.deploymentId,
      vendor: key.vendor,
      provider: providerLabelForKey(key),
      base_weight: key.baseWeight || 1,
      fallback_admission: key.fallbackAdmission || 'always',
      quota_signal_profile: key.quotaSignalProfile || '',
      inflight: state.inflight,
      cap: state.cap,
      cap_history: state.capHistory.slice(),
      cooldown_remaining_ms: Math.max(0, state.badUntil - now),
      outcomes_last_32: summarizeOutcomes(state.outcomes),
      total_2xx_today: state.total2xx,
      total_429_today: state.total429,
      total_401_today: state.total401,
      total_403_today: state.total403,
      total_5xx_today: state.total5xx,
      total_net_err_today: state.totalNetErr,
      consec_5xx: state.consec5xx,
      consec_403: state.consec403,
      consec_err: state.consecErr,
    };

    if (exposeUpstreamHosts) entry.host = key.host;
    if (key.rateLimitPolicy) {
      const rate = rateLimitStatus(state, key.rateLimitPolicy, now);
      entry.rate_limit = {
        requests_per_minute: key.rateLimitPolicy.requestsPerMinute,
        mode: key.rateLimitPolicy.mode,
        remaining: rate.remaining,
        retry_after_ms: Math.max(0, rate.retryAt - now),
      };
    }
    if (key.expiresAtMs > 0) {
      entry.expires_at = new Date(key.expiresAtMs).toISOString();
      entry.expired = now >= key.expiresAtMs;
      entry.expires_in_s = Math.max(0, Math.round((key.expiresAtMs - now) / 1000));
    }

    const cooldownReason = activeCooldownReason(state, now);
    if (cooldownReason) entry.cooldown_reason = cooldownReason;
    const quota = quotaStatus(key.deploymentId, now);
    if (quota?.managed) {
      entry.quota = {
        state: quota.state,
        closed_kind: quota.closedKind || '',
        reason: quota.closedReason || '',
        next_probe_at: quota.nextProbeAt || 0,
      };
    }
    if (key.pathPrefix) entry.path_prefix = key.pathPrefix;
    if (key.modelSet) entry.model_set = [...key.modelSet].sort();
    if (key.canonicalModelSet) entry.canonical_models = [...key.canonicalModelSet].sort();
    if (key.upstreamModelSet) entry.upstream_models = [...key.upstreamModelSet].sort();
    if (key.nativeModels) entry.native_models = [...key.nativeModels].sort();

    if (key.proxyUrl && key.proxyMode === 'fixed-http') {
      entry.proxy_mode = 'fixed-http';
      entry.proxy_configured = true;
    } else if (key.proxyPolicy && ['sticky', 'sticky-auto'].includes(key.proxyPolicy.mode)) {
      Object.assign(entry, stickyRuntime.statusForKey(key));
    }
    if (state.deadModels.size > 0) {
      entry.dead_models = [...state.deadModels.entries()]
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([model, expiresAt]) => ({
          model,
          expires_in_s: Math.round((expiresAt - now) / 1000),
        }));
    }
    return entry;
  });
}
