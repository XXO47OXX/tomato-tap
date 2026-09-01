import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createControlPlaneHandler } from '../src/gateway/control-plane.mjs';

function createHandler({ globallyReady = false, modelAvailable = true } = {}) {
  return createControlPlaneHandler({
    getStatusPayload: () => ({}),
    usageDashboard: {
      snapshot: () => ({}),
      buildHtml: () => '',
      buildPriceHtml: () => '',
    },
    usageHistory: {
      sync: async () => {},
      query: () => ({}),
      buildHtml: () => '',
    },
    modelPricing: { stats: () => ({}), resolve: () => null },
    getRealModels: () => [],
    buildModelInventory: () => [],
    buildLogicalModelInventory: () => [{
      id: 'balanced',
      qualification: {
        dispatchable_deployments: globallyReady ? 1 : 0,
        available_deployments: globallyReady && modelAvailable ? 1 : 0,
      },
    }],
    buildLogicalRoutePlan: ({ model, taskName, excludedVendors, includeEligibilityDetails }) => {
      if (model !== 'balanced') return null;
      return {
        object: 'tomato_tap.route_plan',
        logical_model: 'balanced',
        requested_task: taskName || null,
        health: 'available',
        dispatchable: true,
        available: modelAvailable,
        qualification: {
          dispatchable_deployments: 1,
          available_deployments: modelAvailable ? 1 : 0,
        },
        excluded_vendors: [...excludedVendors],
        details: includeEligibilityDetails,
      };
    },
  });
}

test('control plane exposes liveness and readiness without upstream traffic', async () => {
  const server = await start(createHandler());
  try {
    const health = await call(server, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(health.headers['cache-control'], 'no-store');

    const global = await call(server, '/readyz');
    assert.equal(global.status, 503);
    assert.equal(global.json.status, 'not_ready');

    const model = await call(server, '/readyz?model=BALANCED&task=classification');
    assert.equal(model.status, 200);
    assert.equal(model.json.logical_model, 'balanced');
    assert.equal(model.json.requested_task, 'classification');
    assert.equal(model.json.mode, 'dispatchable');

    const strict = await call(server, '/readyz?model=balanced&mode=available');
    assert.equal(strict.status, 200);
    assert.equal(strict.json.available, true);

    const unknown = await call(server, '/readyz?model=missing');
    assert.equal(unknown.status, 404);

    const wrongMethod = await call(server, '/healthz', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');
  } finally {
    await close(server);
  }
});

test('route plan explains the current decision and requires an exact logical model', async () => {
  const server = await start(createHandler({ globallyReady: true }));
  try {
    assert.equal((await call(server, '/readyz')).status, 200);

    const missing = await call(server, '/__route/plan');
    assert.equal(missing.status, 400);

    const plan = await call(
      server,
      '/__route/plan?model=balanced&task=classification&exclude_vendor=alpha,beta',
    );
    assert.equal(plan.status, 200);
    assert.equal(plan.json.object, 'tomato_tap.route_plan');
    assert.equal(plan.json.details, true);
    assert.deepEqual(plan.json.excluded_vendors, ['alpha', 'beta']);
  } finally {
    await close(server);
  }
});

test('validated readiness distinguishes probing capacity from proven availability', async () => {
  const server = await start(createHandler({ globallyReady: true, modelAvailable: false }));
  try {
    const dispatchable = await call(server, '/readyz');
    assert.equal(dispatchable.status, 200);
    assert.deepEqual(dispatchable.json.dispatchable_logical_models, ['balanced']);
    assert.deepEqual(dispatchable.json.available_logical_models, []);

    const strict = await call(server, '/readyz?mode=available');
    assert.equal(strict.status, 503);
    assert.equal(strict.json.mode, 'available');

    const model = await call(server, '/readyz?model=balanced&mode=available');
    assert.equal(model.status, 503);
    assert.equal(model.json.dispatchable, true);
    assert.equal(model.json.available, false);

    const invalid = await call(server, '/readyz?mode=optimistic');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.type, 'invalid_readiness_mode');
  } finally {
    await close(server);
  }
});

function start(controlPlane) {
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const parsedUrl = new URL(request.url, 'http://127.0.0.1');
      const handled = await controlPlane.handleGlobal(request, response, {
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

function call(server, path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
