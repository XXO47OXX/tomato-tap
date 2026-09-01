import assert from 'node:assert/strict';
import { applyProxyCooldown, initializeStickyProxyRuntime } from '../src/egress/sticky-proxy-runtime.mjs';

const subscription = Buffer.from(
  'vless://11111111-1111-4111-8111-111111111111@edge.example:443?security=tls&type=ws&path=%2Fedge',
).toString('base64');
const ensured = [];
let stopped = false;
let listenerState = 'running';
const manager = {
  ensure(node, localPort) {
    ensured.push({ node, localPort });
    return { proxyUrl: `http://127.0.0.1:${localPort}`, state: 'running' };
  },
  status(nodeId) {
    if (nodeId === 'deadbeef12345678') return null;
    return { nodeId, localPort: 11001, state: listenerState, lastError: '' };
  },
  stopAll() { stopped = true; return Promise.resolve(); },
};
const bindings = {
  load() {},
  resolve(deploymentId) { return { nodeId: 'known-node', localPort: deploymentId === 'a' ? 11001 : 11002 }; },
};
const keys = [
  { deploymentId: 'a', proxyPolicy: { mode: 'sticky-auto', nodeId: null } },
  { deploymentId: 'b', proxyPolicy: { mode: 'direct', nodeId: null } },
];

const runtime = await initializeStickyProxyRuntime({
  keys,
  subscriptionUrl: 'https://secret.example/subscription',
  fetchText: async () => subscription,
  bindingStore: {
    ...bindings,
    resolve(deploymentId, policy, nodes) {
      assert.equal(nodes.length, 1);
      return { nodeId: nodes[0].id, localPort: deploymentId === 'a' ? 11001 : 11002 };
    },
  },
  manager,
});

assert.equal(keys[0].proxyUrl, 'http://127.0.0.1:11001');
assert.equal(keys[0].proxyMode, 'sticky-auto');
assert.equal(keys[0].proxyNodeId.length, 16);
assert.equal(keys[0].proxyUnavailable, false);
assert.equal(keys[1].proxyUrl, undefined, 'direct key remains untouched');
assert.equal(ensured.length, 1);
assert.equal(runtime.isKeyAvailable(keys[0]), true);
listenerState = 'error';
assert.equal(runtime.isKeyAvailable(keys[0]), false, 'failed listener disables only its bound key');
assert.equal(runtime.isKeyAvailable(keys[1]), true, 'direct key stays eligible');

const secondSubscription = Buffer.from(
  'vless://22222222-2222-4222-8222-222222222222@edge-2.example:443?security=tls&type=tcp',
).toString('base64');
let mergedNodeCount = 0;
await initializeStickyProxyRuntime({
  keys: [{ deploymentId: 'multi', proxyPolicy: { mode: 'sticky-auto', nodeId: null } }],
  subscriptionUrl: ['https://secret.example/one', 'https://secret.example/two'],
  fetchText: async (url) => url.endsWith('/one') ? subscription : secondSubscription,
  bindingStore: {
    load() {},
    resolve(_deploymentId, _policy, nodes) {
      mergedNodeCount = nodes.length;
      return { nodeId: nodes[0].id, localPort: 11005 };
    },
  },
  manager,
});
assert.equal(mergedNodeCount, 2, 'multiple subscriptions are merged without replacing old nodes');

let staticNodeCount = 0;
await initializeStickyProxyRuntime({
  keys: [{ deploymentId: 'static', proxyPolicy: { mode: 'sticky-auto', nodeId: null } }],
  subscriptionUrl: '',
  staticSubscriptionText: 'vless://33333333-3333-4333-8333-333333333333@static.example:443?security=reality&type=tcp&sni=example.com&pbk=test',
  fetchText: async () => { throw new Error('static nodes must not be fetched'); },
  bindingStore: {
    load() {},
    resolve(_deploymentId, _policy, nodes) {
      staticNodeCount = nodes.length;
      return { nodeId: nodes[0].id, localPort: 11006 };
    },
  },
  manager,
});
assert.equal(staticNodeCount, 1, 'raw static VLESS nodes join the candidate pool without a remote subscription');
listenerState = 'running';
const failedResult = runtime.recordResult(keys[0], { status: 0, networkError: Object.assign(new Error('proxy CONNECT failed'), { code: 'ECONNRESET' }) });
assert.equal(failedResult.cooldownMs, 60_000, 'proxy transport failure requests immediate key-only cooldown');
const failedState = { badUntil: 500 };
const healthyState = { badUntil: 700 };
applyProxyCooldown(failedState, failedResult, 1_000);
assert.equal(failedState.badUntil, 61_000);
assert.equal(failedState.cooldownReason, 'proxy_transport');
assert.equal(runtime.statusForKey(keys[0]).proxy_error, 'proxy_connect_failed');
const healthyResult = runtime.recordResult(keys[0], { status: 200, networkError: null });
applyProxyCooldown(healthyState, healthyResult, 1_000);
assert.equal(healthyState.badUntil, 700, 'unrelated key state remains unchanged');
assert.equal(healthyResult.cooldownMs, 0);
assert.equal(runtime.statusForKey(keys[0]).proxy_error, '');
const internalResult = runtime.recordResult(keys[0], {
  status: 0, networkError: new Error('adapter failed'), failureOrigin: 'internal',
});
assert.equal(internalResult.cooldownMs, 0, 'internal adapter errors must not cool proxy keys');
assert.equal(runtime.statusForKey(keys[0]).proxy_error, '');
const publicState = JSON.stringify(runtime.statusForKey(keys[0]));
assert(!publicState.includes('secret.example'));
assert(!publicState.includes('11111111-1111-4111-8111-111111111111'));
const stopPromise = runtime.stopAll();
assert(stopPromise instanceof Promise);
await stopPromise;
assert.equal(stopped, true);

const failedKey = { deploymentId: 'failed', proxyPolicy: { mode: 'sticky-auto', nodeId: null } };
await initializeStickyProxyRuntime({
  keys: [failedKey],
  subscriptionUrl: '',
  fetchText: async () => { throw new Error('must not fetch'); },
  bindingStore: bindings,
  manager,
});
assert.equal(failedKey.proxyUnavailable, true);
assert.equal(failedKey.proxyError, 'subscription_not_configured');

const missingNodeKey = { deploymentId: 'missing', proxyPolicy: { mode: 'sticky-auto', nodeId: null } };
const missingNodeRuntime = await initializeStickyProxyRuntime({
  keys: [missingNodeKey],
  subscriptionUrl: 'https://secret.example/subscription',
  fetchText: async () => subscription,
  bindingStore: {
    load() {},
    resolve() {
      throw Object.assign(new Error('bound proxy node unavailable'), {
        code: 'BOUND_NODE_UNAVAILABLE', nodeId: 'deadbeef12345678', localPort: 11009,
      });
    },
  },
  manager,
});
const missingStatus = missingNodeRuntime.statusForKey(missingNodeKey);
assert.equal(missingStatus.proxy_node, 'deadbeef12345678');
assert.equal(missingStatus.proxy_port, 11009);
assert.equal(missingStatus.proxy_listener, 'unavailable');

const retryKey = { deploymentId: 'retry', proxyPolicy: { mode: 'sticky-auto', nodeId: null } };
let fetchAttempts = 0;
const retryRuntime = await initializeStickyProxyRuntime({
  keys: [retryKey],
  subscriptionUrl: 'https://secret.example/subscription',
  fetchText: async () => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error('transient failure');
    return subscription;
  },
  bindingStore: {
    load() {},
    resolve(_deploymentId, _policy, nodes) { return { nodeId: nodes[0].id, localPort: 11003 }; },
  },
  manager,
  retryIntervalMs: 25,
});
assert.equal(retryKey.proxyUnavailable, true, 'initial fetch failure marks key unavailable');
assert.equal(retryKey.proxyError, 'subscription_unavailable');
await new Promise((resolve) => setTimeout(resolve, 120));
assert.equal(fetchAttempts >= 2, true, 'subscription is retried in background');
assert.equal(retryKey.proxyUnavailable, false, 'successful retry restores the binding');
assert.equal(retryKey.proxyNodeId.length, 16);
assert.equal(retryKey.proxyUrl, 'http://127.0.0.1:11003');
await retryRuntime.stopAll();
const attemptsAtStop = fetchAttempts;
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(fetchAttempts, attemptsAtStop, 'stopAll halts background retries');

// dispose() halts a runtime's own timers without touching the shared manager
// (config generations replace runtimes, but sing-box listeners stay shared).
{
  let managerStops = 0;
  const disposeRuntime = await initializeStickyProxyRuntime({
    keys: [{ deploymentId: 'dispose-key', proxyPolicy: { mode: 'sticky-auto', nodeId: null } }],
    subscriptionUrl: 'https://secret.example/subscription',
    fetchText: async () => subscription,
    bindingStore: {
      load() {},
      resolve(_deploymentId, _policy, nodes) { return { nodeId: nodes[0].id, localPort: 11004 }; },
    },
    manager: {
      ensure(node, localPort) { return { proxyUrl: `http://127.0.0.1:${localPort}`, state: 'running' }; },
      status(nodeId) { return { nodeId, localPort: 11004, state: 'running', lastError: '' }; },
      stopAll() { managerStops += 1; return Promise.resolve(); },
    },
  });
  disposeRuntime.dispose();
  await disposeRuntime.stopAll();
  assert.equal(managerStops, 1, 'dispose never stops the manager; stopAll does exactly once');
}

console.log('test_sticky_proxy_runtime: ok');
