import assert from 'node:assert/strict';

import { buildKeyPoolStatus, providerLabelForKey } from '../src/gateway/key-pool-status.mjs';
import { createInitialKeyState } from '../src/state/key-state.mjs';

const key = {
  name: 'tomato_tap_relay_example',
  deploymentId: 'example-1',
  providerLabel: 'provider-a',
  vendor: 'relay',
  host: 'private-upstream.example',
  expiresAtMs: 0,
};
const state = createInitialKeyState(2);
const stickyRuntime = { statusForKey: () => ({ proxy_mode: 'direct' }) };

assert.equal(providerLabelForKey(key), 'provider-a');

const redacted = buildKeyPoolStatus({
  keys: [key],
  states: [state],
  stickyRuntime,
});
assert.equal(redacted[0].provider, 'provider-a');
assert.equal(Object.hasOwn(redacted[0], 'host'), false);
assert.equal(JSON.stringify(redacted).includes('private-upstream.example'), false);

const exposed = buildKeyPoolStatus({
  keys: [key],
  states: [state],
  stickyRuntime,
  exposeUpstreamHosts: true,
});
assert.equal(exposed[0].host, 'private-upstream.example');

console.log('test_key_pool_status: ok');
