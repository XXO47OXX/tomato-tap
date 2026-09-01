import { parseProxySubscription } from './proxy-subscription.mjs';
import { setKeyCooldown } from '../state/key-cooldown.mjs';

export function applyProxyCooldown(state, outcome, now = Date.now()) {
  if (!state || !outcome || outcome.cooldownMs <= 0) return;
  setKeyCooldown(state, 'proxy_transport', now + outcome.cooldownMs);
}

export async function initializeStickyProxyRuntime({
  keys,
  subscriptionUrl,
  staticSubscriptionText = '',
  fetchText,
  bindingStore,
  manager,
  retryIntervalMs = 60_000,
}) {
  const stickyKeys = (keys || []).filter((key) =>
    key.proxyPolicy && ['sticky', 'sticky-auto'].includes(key.proxyPolicy.mode));
  if (stickyKeys.length === 0) return createRuntime(manager);
  const subscriptionUrls = normalizeSubscriptionUrls(subscriptionUrl);
  const staticNodes = parseProxySubscription(staticSubscriptionText);
  if (subscriptionUrls.length === 0 && staticNodes.length === 0) {
    for (const key of stickyKeys) markUnavailable(key, 'subscription_not_configured');
    return createRuntime(manager);
  }

  let stopped = false;
  let retryTimer = null;

  const resolveAll = (nodes) => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const key of stickyKeys) {
      try {
        const binding = bindingStore.resolve(key.deploymentId, key.proxyPolicy, nodes);
        const node = nodesById.get(binding.nodeId);
        if (!node) throw new Error('bound node unavailable');
        const listener = manager.ensure(node, binding.localPort);
        key.proxyUrl = listener.proxyUrl;
        key.proxyMode = key.proxyPolicy.mode;
        key.proxyNodeId = binding.nodeId;
        key.proxyLocalPort = binding.localPort;
        key.proxyUnavailable = listener.state === 'error';
        key.proxyError = listener.state === 'error' ? (listener.lastError || 'listener_error') : '';
      } catch (error) {
        if (error?.code === 'BOUND_NODE_UNAVAILABLE') {
          key.proxyNodeId = error.nodeId || '';
          key.proxyLocalPort = error.localPort || null;
        }
        markUnavailable(key, classifyRuntimeError(error));
      }
    }
  };

  const loadOnce = async () => {
    let nodes;
    try {
      const results = await Promise.allSettled(
        subscriptionUrls.map(async (url) => parseProxySubscription(await fetchText(url))),
      );
      const merged = new Map(staticNodes.map((node) => [node.id, node]));
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const node of result.value) merged.set(node.id, node);
      }
      nodes = [...merged.values()];
      if (nodes.length === 0) throw new Error('empty');
      bindingStore.load();
    } catch {
      for (const key of stickyKeys) markUnavailable(key, 'subscription_unavailable');
      return false;
    }
    if (stopped) return true;
    resolveAll(nodes);
    return true;
  };

  // 订阅一次性失败不认命：后台定期重试，机场/订阅恢复后自动重新解析节点、
  // 重建绑定，无需重启 tap。定时器 unref，不阻塞进程退出。
  if (!(await loadOnce())) {
    const schedule = () => {
      if (stopped) return;
      retryTimer = setTimeout(async () => {
        retryTimer = null;
        await loadOnce();
        if (!stopped) schedule();
      }, retryIntervalMs);
      retryTimer.unref?.();
    };
    schedule();
  }

  return createRuntime(manager, () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
  });
}

function normalizeSubscriptionUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))];
}

function createRuntime(manager, onStop) {
  return {
    isKeyAvailable(key) {
      if (!key?.proxyPolicy || !['sticky', 'sticky-auto'].includes(key.proxyPolicy.mode)) return true;
      if (key.proxyUnavailable || !key.proxyUrl || !key.proxyNodeId) return false;
      return manager.status(key.proxyNodeId)?.state === 'running';
    },
    recordResult(key, result) {
      if (!key?.proxyNodeId) return { cooldownMs: 0 };
      if (result?.networkError && result.failureOrigin !== 'internal') {
        key.proxyError = classifyProxyNetworkError(result.networkError);
        return { cooldownMs: 60_000 };
      } else if (result?.status >= 200 && result.status < 300) {
        key.proxyError = '';
      }
      return { cooldownMs: 0 };
    },
    statusForKey(key) {
      const listener = key.proxyNodeId ? manager.status(key.proxyNodeId) : null;
      return {
        proxy_mode: key.proxyMode || key.proxyPolicy?.mode || 'direct',
        proxy_node: key.proxyNodeId || '',
        proxy_port: listener?.localPort || key.proxyLocalPort || 0,
        proxy_listener: listener?.state || (key.proxyUnavailable ? 'unavailable' : ''),
        proxy_error: key.proxyError || listener?.lastError || '',
      };
    },
    // Halts this runtime's own timers only. The manager (sing-box listeners)
    // is shared across config generations, so replacing a runtime must NOT
    // stop the manager — the incoming generation reuses the same listeners.
    dispose() {
      if (onStop) onStop();
    },
    stopAll() {
      if (onStop) onStop();
      return manager.stopAll();
    },
  };
}

function markUnavailable(key, error) {
  key.proxyMode = key.proxyPolicy?.mode || 'direct';
  key.proxyUnavailable = true;
  key.proxyError = error;
  key.proxyUrl = null;
}

function classifyRuntimeError(error) {
  if (error?.code === 'BOUND_NODE_UNAVAILABLE') return 'bound_node_unavailable';
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('bound proxy node')) return 'bound_node_unavailable';
  if (message.includes('no free local port')) return 'proxy_port_exhausted';
  return 'proxy_runtime_error';
}

function classifyProxyNetworkError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'ECONNREFUSED') return 'proxy_listener_unreachable';
  if (message.includes('proxy connect')) return 'proxy_connect_failed';
  return 'proxy_transport_error';
}
