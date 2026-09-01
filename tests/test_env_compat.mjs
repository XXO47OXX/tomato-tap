import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLegacyEnvAliases,
  canonicalCredentialName,
  relayCredential,
} from '../src/config/env-compat.mjs';
import { gatewayHeader } from '../src/routing/logical-dispatch.mjs';

test('legacy environment variables populate canonical names without overriding them', () => {
  const env = {
    MIMO_TAP_BIND_HOST: '127.0.0.2',
    TOMATO_TAP_BIND_HOST: '127.0.0.1',
    MIMO_TAP_MODELS_PATH: '/legacy/models.json',
  };
  const aliases = applyLegacyEnvAliases(env);

  assert.equal(env.TOMATO_TAP_BIND_HOST, '127.0.0.1');
  assert.equal(env.TOMATO_TAP_MODELS_PATH, '/legacy/models.json');
  assert.deepEqual(aliases, [{
    legacyName: 'MIMO_TAP_MODELS_PATH',
    canonicalName: 'TOMATO_TAP_MODELS_PATH',
  }]);
});

test('relay credentials prefer the Tomato Tap namespace', () => {
  const env = {
    mimotap_relay_example_key: 'legacy',
    tomato_tap_relay_example_key: 'canonical',
  };
  assert.equal(relayCredential(env, 'example'), 'canonical');
  assert.equal(canonicalCredentialName('mimotap_relay_example'), 'tomato_tap_relay_example');
});

test('canonical gateway headers win while legacy client headers remain accepted', () => {
  assert.equal(gatewayHeader({ 'x-mimo-task': 'legacy' }, 'task'), 'legacy');
  assert.equal(gatewayHeader({
    'x-mimo-task': 'legacy',
    'x-tomato-tap-task': 'canonical',
  }, 'task'), 'canonical');
});
