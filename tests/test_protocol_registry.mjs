import assert from 'node:assert/strict';
import {
  authBearer,
  authXApiKey,
  applyRelayAuth,
  createVendorFunctionRegistry,
  disableThinking,
  injectReasoningSplit,
} from '../src/providers/protocol-registry.mjs';

const bearerHeaders = { authorization: 'old', 'x-api-key': 'old' };
authBearer(bearerHeaders, 'secret');
assert.deepEqual(bearerHeaders, { Authorization: 'Bearer secret' });

const keyHeaders = { Authorization: 'old', 'X-Api-Key': 'old' };
authXApiKey(keyHeaders, 'secret');
assert.deepEqual(keyHeaders, { 'x-api-key': 'secret' });

const relayHeaders = { Authorization: 'old' };
applyRelayAuth(relayHeaders, 'relay-secret', 'x-api-key', authBearer);
assert.deepEqual(relayHeaders, { 'x-api-key': 'relay-secret' });

const headers = { 'content-type': 'application/json' };
const split = JSON.parse(injectReasoningSplit(Buffer.from('{"model":"x"}'), headers));
assert.equal(split.reasoning_split, true);
const disabled = JSON.parse(disableThinking(Buffer.from('{"model":"x"}'), headers));
assert.equal(disabled.chat_template_kwargs.enable_thinking, false);
assert.equal(disabled.thinking.type, 'disabled');

const registry = createVendorFunctionRegistry();
assert.equal(registry.auth.bearer, authBearer);
assert.equal(typeof registry.transform.transformCodexToChat, 'function');

console.log('test_protocol_registry: ok');
