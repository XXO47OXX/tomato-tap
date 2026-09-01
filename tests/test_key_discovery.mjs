import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';

import { buildKeyPool, discoverKeysForVendor } from '../src/providers/key-discovery.mjs';

const singleVendor = {
  envDiscovery: 'single',
  envPrefix: /^provider_key_/i,
  defaultHost: 'api.example.com',
  nativeModels: ['model-a'],
};
const single = discoverKeysForVendor({
  vendorName: 'provider',
  vendorConfig: singleVendor,
  env: {
    provider_key_b: 'token-b',
    provider_key_a: 'token-a',
    provider_key_a_host: 'region.example.com',
  },
  relayRegistry: { relays: {} },
});
assert.equal(single.length, 2);
assert.equal(single[0].name, 'provider_key_a');
assert.equal(single[0].host, 'region.example.com');
assert.equal(single[0].providerLabel, 'provider');
assert.deepEqual(single[0].nativeModels, ['model-a']);

const dumpPath = `/tmp/tomato-tap-key-discovery-${process.pid}.json`;
writeFileSync(dumpPath, JSON.stringify({
  accounts: [
    {
      name: 'Account One',
      platform: 'openai',
      type: 'oauth',
      credentials: { access_token: 'token-1', chatgpt_account_id: 'account-1' },
    },
    {
      name: 'Duplicate',
      platform: 'openai',
      type: 'oauth',
      credentials: { access_token: 'token-1', chatgpt_account_id: 'account-1' },
    },
  ],
}));
try {
  const messages = [];
  const dumped = discoverKeysForVendor({
    vendorName: 'oauth-provider',
    vendorConfig: {
      envDiscovery: 'dump_file',
      envDumpPath: 'OAUTH_DUMP_PATH',
      defaultHost: 'accounts.example.com',
    },
    env: { OAUTH_DUMP_PATH: dumpPath },
    relayRegistry: { relays: {} },
    logger: {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });
  assert.equal(dumped.length, 1);
  assert.equal(dumped[0].chatgptAccountId, 'account-1');
  assert.equal(dumped[0].providerLabel, 'oauth-provider');
  assert.equal(messages.length, 1);
} finally {
  unlinkSync(dumpPath);
}

const built = buildKeyPool({
  VENDORS: { provider: singleVendor },
  env: { provider_key_a: 'token-a' },
  relayRegistry: { relays: {} },
});
assert.equal(built.length, 1);
assert.equal(built[0].deploymentId, 'provider-1');

console.log('test_key_discovery: ok');
