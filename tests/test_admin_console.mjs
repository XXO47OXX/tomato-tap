import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createAdminConsole, sanitizeAdminStatus } from '../src/admin/admin-console.mjs';

function configSnapshot() {
  return {
    configured: false,
    paths: { env: '…/tomato/.env', relays: '…/local/relays.json', models: '…/local/models.json' },
    providers: [], realModels: [], logicalModels: [], settings: {},
  };
}

test('admin console serves one local UI and redacted management APIs', async () => {
  let saved = null;
  let egressSaved = null;
  const store = {
    snapshot: configSnapshot,
    upsertProvider(value) { saved = value; return configSnapshot(); },
    setProviderEnabled() { return configSnapshot(); },
    removeProvider() { return configSnapshot(); },
    upsertLogicalModel() { return configSnapshot(); },
    removeLogicalModel() { return configSnapshot(); },
    updateSettings() { return configSnapshot(); },
    updateEgress(value) { egressSaved = value; return configSnapshot(); },
    providerDiscoveryTarget(value) {
      return { ...value, apiKey: 'write-only-discovery-key' };
    },
  };
  const consoleApp = createAdminConsole({
    configStore: store,
    getStatusPayload: () => ({ key_pool: [], runtime_config: {} }),
    getPhysicalModels: () => [],
    getLogicalModels: () => [],
    getUsageToday: () => ({ total: {} }),
    reloadRuntime: async () => ({ active_revision: 'revision-a' }),
    discoverModels: async (target) => ({
      object: 'tomato_tap.model_discovery',
      models: ['model-a'],
      count: 1,
      authenticated: Boolean(target.apiKey),
    }),
    bindHost: '127.0.0.1',
  });
  const server = await start(consoleApp);
  try {
    const page = await call(server, '/admin/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Tomato Tap Console/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    const asset = await call(server, '/admin/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /text\/javascript/);
    assert.equal((await call(server, '/admin/egress')).status, 200);
    assert.equal((await call(server, '/admin/connections')).status, 200);
    assert.equal((await call(server, '/admin/diagnostics')).status, 200);
    assert.equal((await call(server, '/admin/assets/model-picker.js')).status, 200);

    const bootstrap = await call(server, '/admin/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.json.object, 'tomato_tap.admin_bootstrap');
    assert.equal(bootstrap.json.configuration.configured, false);

    const rejected = await call(server, '/admin/api/providers', {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    assert.equal(rejected.status, 403);
    assert.equal(saved, null);

    const accepted = await call(server, '/admin/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id: 'provider-a', apiKey: 'write-only-value' }),
      headers: {
        'content-type': 'application/json',
        'x-tomato-tap-admin': 'console',
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal(saved.id, 'provider-a');
    assert.equal(JSON.stringify(accepted.json).includes('write-only-value'), false);

    const discovered = await call(server, '/admin/api/providers/discover-models', {
      method: 'POST',
      body: JSON.stringify({ id: 'provider-a', baseUrl: 'https://api.example.test/v1' }),
      headers: {
        'content-type': 'application/json',
        'x-tomato-tap-admin': 'console',
      },
    });
    assert.equal(discovered.status, 200);
    assert.deepEqual(discovered.json.models, ['model-a']);
    assert.equal(JSON.stringify(discovered.json).includes('write-only-discovery-key'), false);
    const discoveryWrongMethod = await call(server, '/admin/api/providers/discover-models');
    assert.equal(discoveryWrongMethod.status, 405);
    assert.equal(discoveryWrongMethod.headers.allow, 'POST');

    const egress = await call(server, '/admin/api/egress', {
      method: 'PUT',
      body: JSON.stringify({ subscriptionUrls: 'https://proxy.example.test/sub' }),
      headers: {
        'content-type': 'application/json',
        'x-tomato-tap-admin': 'console',
      },
    });
    assert.equal(egress.status, 200);
    assert.equal(egressSaved.subscriptionUrls, 'https://proxy.example.test/sub');
    assert.equal(egress.json.restart_required, false);
    const sharedProxy = await call(server, '/admin/api/egress', {
      method: 'PUT',
      body: JSON.stringify({ sharedProxyUrl: 'http://127.0.0.1:7890' }),
      headers: {
        'content-type': 'application/json',
        'x-tomato-tap-admin': 'console',
      },
    });
    assert.equal(sharedProxy.status, 200);
    assert.equal(sharedProxy.json.restart_required, true);
  } finally {
    await close(server);
  }
});

test('admin API requires a token when configured or refuses unsafe remote trusted mode', async () => {
  const store = { snapshot: configSnapshot };
  const remote = createAdminConsole({
    configStore: store,
    getStatusPayload: () => ({}),
    bindHost: '0.0.0.0',
  });
  const remoteServer = await start(remote);
  try {
    assert.equal((await call(remoteServer, '/admin/api/bootstrap')).status, 403);
  } finally {
    await close(remoteServer);
  }

  const protectedConsole = createAdminConsole({
    configStore: store,
    getStatusPayload: () => ({}),
    bindHost: '0.0.0.0',
    adminToken: 'local-admin-token',
  });
  const protectedServer = await start(protectedConsole);
  try {
    assert.equal((await call(protectedServer, '/admin/api/bootstrap')).status, 401);
    const allowed = await call(protectedServer, '/admin/api/bootstrap', {
      headers: { authorization: 'Bearer local-admin-token' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.access.token_required, true);
  } finally {
    await close(protectedServer);
  }
});

test('admin diagnostic detail levels expose operator metadata without returning credentials', () => {
  const status = {
    key_pool: [{
      name: 'provider-a-key-01',
      host: 'api.example.test',
      cap: 4,
    }],
    quota_infer_events: [{
      key: 'provider-a-key-01',
      vendor: 'provider-a',
      body_snippet: 'quota exceeded',
    }],
  };
  const safe = sanitizeAdminStatus(status, 'safe');
  assert.equal(safe.key_pool[0].slot_id, 'key-001');
  assert.equal(Object.hasOwn(safe.key_pool[0], 'name'), false);
  assert.equal(Object.hasOwn(safe.key_pool[0], 'host'), false);
  assert.equal(Object.hasOwn(safe.quota_infer_events[0], 'key'), false);
  assert.equal(Object.hasOwn(safe.quota_infer_events[0], 'body_snippet'), false);

  const operator = sanitizeAdminStatus(status, 'operator');
  assert.equal(operator.key_pool[0].name, 'provider-a-key-01');
  assert.equal(operator.key_pool[0].host, 'api.example.test');
  assert.equal(operator.quota_infer_events[0].key, 'provider-a-key-01');
  assert.equal(Object.hasOwn(operator.quota_infer_events[0], 'body_snippet'), false);

  const debug = sanitizeAdminStatus(status, 'debug');
  assert.equal(debug.quota_infer_events[0].body_snippet, 'quota exceeded');
  assert.equal(JSON.stringify(debug).includes('actual-api-secret'), false);
});

function start(consoleApp) {
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const parsedUrl = new URL(request.url, 'http://127.0.0.1');
      const handled = await consoleApp.handle(request, response, {
        pathname: parsedUrl.pathname,
        parsedUrl,
      });
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function call(server, path, { method = 'GET', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: body ? { 'content-length': Buffer.byteLength(body), ...headers } : headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* HTML/static response */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
