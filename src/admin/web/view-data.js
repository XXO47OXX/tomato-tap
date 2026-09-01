export function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

export function slotModels(slot = {}) {
  return new Set([
    ...(slot.canonical_models || []),
    ...(slot.model_set || []),
    ...(slot.upstream_models || []),
    ...(slot.native_models || []),
  ].map(normalizeModelName).filter(Boolean));
}

export function keyErrors(key = {}) {
  return ['total_429_today', 'total_401_today', 'total_403_today', 'total_5xx_today', 'total_net_err_today']
    .reduce((sum, field) => sum + (Number(key[field]) || 0), 0);
}

export function summarizeKeys(keys = []) {
  return keys.reduce((summary, key) => {
    const cooling = Number(key.cooldown_remaining_ms) > 0;
    summary.hot += !key.proxy_error && !key.expired && !cooling && Number(key.inflight) < Number(key.cap) ? 1 : 0;
    summary.cooling += cooling ? 1 : 0;
    summary.inflight += Number(key.inflight) || 0;
    summary.cap += Number(key.cap) || 0;
    summary.success += Number(key.total_2xx_today) || 0;
    summary.errors += keyErrors(key);
    summary.attempts += (Number(key.total_2xx_today) || 0) + keyErrors(key);
    return summary;
  }, { hot: 0, cooling: 0, inflight: 0, cap: 0, success: 0, errors: 0, attempts: 0 });
}

export function providerReady(provider, keys = []) {
  if (!provider?.enabled || !provider?.credential?.configured) return false;
  return keys.some((key) => key.deployment === provider.id
    && !key.proxy_error
    && !key.expired
    && Number(key.cooldown_remaining_ms) <= 0
    && Number(key.inflight) < Number(key.cap));
}

export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
}

export function slotState(key = {}) {
  if (key.proxy_error) return { lamp: 'bad', label: '出口异常' };
  if (key.expired) return { lamp: 'bad', label: '已过期' };
  if (Number(key.cooldown_remaining_ms) > 0) {
    return { lamp: 'warn', label: `冷却 ${formatCountdown(key.cooldown_remaining_ms)}` };
  }
  if (Number(key.inflight) >= Number(key.cap)) return { lamp: 'idle', label: '并发已满' };
  return { lamp: 'ok', label: '可调度' };
}

export function slotSummary(keys = []) {
  if (keys.some((key) => slotState(key).lamp === 'ok')) return { lamp: 'ok', label: '可调度' };
  if (keys.some((key) => slotState(key).lamp === 'warn')) return { lamp: 'warn', label: '冷却中' };
  if (keys.length) return { lamp: 'idle', label: '暂不可用' };
  return { lamp: 'off', label: '没有槽位' };
}

export function proxyPolicyValue(proxy) {
  if (proxy === true) return 'shared';
  if (!proxy) return 'direct';
  return proxy.mode || 'direct';
}

export function proxyModeName(mode) {
  return ({
    direct: '直连',
    shared: '共享代理',
    'sticky-auto': '自动粘性出口',
    sticky: '固定出口',
    'fixed-http': 'Key 独立代理',
  })[mode] || mode || '直连';
}
