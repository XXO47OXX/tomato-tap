import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'mimo-logical-dispatch-'));
const calls = { a: 0, b: 0, c: 0 };
let rateLimit = false;
let headersA = null;
let holdNextA = false;
let pendingA = null;
let holdNextB = false;
let pendingB = null;
let abortMode = false;
let abortSeen = 0;
let child;

const upstreamA = await startServer((req, res) => {
  calls.a++;
  headersA = req.headers;
  collectBody(req).then((body) => {
    assert.equal(JSON.parse(body).model, 'real-a');
    if (holdNextA) {
      holdNextA = false;
      pendingA = res;
      return;
    }
    if (abortMode) {
      abortSeen++;
      return;
    }
    if (rateLimit) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: { message: 'limited' } }));
      return;
    }
    if (abortMode) {
      abortSeen++;
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'real-a', choices: [] }));
  });
});
const upstreamB = await startServer((req, res) => {
  calls.b++;
  collectBody(req).then((body) => {
    assert.equal(JSON.parse(body).model, 'real-b');
    if (holdNextB) {
      holdNextB = false;
      pendingB = res;
      return;
    }
    if (rateLimit) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: { message: 'limited' } }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'real-b',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }, 150);
  });
});
const upstreamC = await startServer((req, res) => {
  calls.c++;
  collectBody(req).then((body) => {
    assert.equal(JSON.parse(body).model, 'real-c');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'real-c', choices: [{ message: { content: 'wrong-capability' } }] }));
  });
});

try {
  const proxyPort = await freePort();
  const policyPath = join(temp, 'models.json');
  const relaysPath = join(temp, 'relays.json');
  const vendorsPath = join(temp, 'vendors.json');
  const envPath = join(temp, '.env');
  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1,
    realModels: {
      'real-a': realModel(),
      'real-b': { ...realModel(), initialLatencyMs: 1 },
      'real-c': { ...realModel(), capabilities: ['strict_json', 'structured_output'] },
    },
    taskSubtypes: {
      'structured-generation': {
        requiredCapabilities: ['strict_json', 'structured_output', 'long_output'],
        candidates: ['real-a', 'real-b'],
        maxAttempts: 3,
        deadlineMs: 5000,
      },
    },
    logicalModels: {
      balanced: {
        requiredCapabilities: ['strict_json', 'structured_output'],
        candidates: ['real-a', 'real-b', 'real-c'],
        candidateStrategy: 'ordered',
        allowedTaskSubtypes: ['structured-generation'],
        maxInflight: 4,
        maxAttempts: 3,
        deadlineMs: 5000,
        request: { maxInputTokens: 1000 },
      },
    },
  }));
  writeFileSync(relaysPath, JSON.stringify({
    schemaVersion: 1,
    relays: {
      a: { host: '127.0.0.1', proto: 'http', port: upstreamA.port, path: '/v1', models: ['real-a'], cap: { initial: 1, min: 1, max: 1 } },
      b: { host: '127.0.0.1', proto: 'http', port: upstreamB.port, path: '/v1', models: ['real-b'], cap: { initial: 1, min: 1, max: 1 }, weight: 100 },
      c: { host: '127.0.0.1', proto: 'http', port: upstreamC.port, path: '/v1', models: ['real-c'], cap: { initial: 1, min: 1, max: 1 } },
    },
  }));
  writeFileSync(vendorsPath, JSON.stringify({
    schemaVersion: 1,
    vendors: [
      {
        id: 'relay',
        envDiscovery: 'multi',
        envPrefix: '^tomato_tap_relay_(.+?)_key$',
        routes: [{ prefix: '/oa/v1', apiFormat: 'openai', auth: 'bearer', rewrite: { from: '^/oa/v1', to: '' } }],
      },
      {
        id: 'direct',
        envDiscovery: 'multi',
        envPrefix: '^tomato_tap_direct_(.+?)_key$',
        routes: [{ prefix: '/direct/v1', apiFormat: 'openai', auth: 'bearer', rewrite: { from: '^/direct/v1', to: '' } }],
      },
    ],
  }));
  writeFileSync(envPath, 'tomato_tap_direct_a_key=test-a\ntomato_tap_direct_b_key=test-b\ntomato_tap_direct_c_key=test-c\n');

  const output = [];
  child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      PORT: String(proxyPort),
      TOMATO_TAP_ENV_FILE: envPath,
      TOMATO_TAP_MODELS_PATH: policyPath,
      TOMATO_TAP_RELAYS_PATH: relaysPath,
      TOMATO_TAP_VENDORS_PATH: vendorsPath,
      TOMATO_TAP_STATE_DIR: temp,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output.push(chunk.toString());
    if (process.env.DEBUG_LOGICAL_TEST) process.stderr.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output.push(chunk.toString());
    if (process.env.DEBUG_LOGICAL_TEST) process.stderr.write(chunk);
  });

  await waitUntilReady(proxyPort, child, output);
  const status = await requestJsonGet(proxyPort, '/__status');
  assert.deepEqual(status.body.logical_scheduler.policies, ['balanced']);
  const logicalStatusText = JSON.stringify(status.body.logical_scheduler);
  assert.equal(logicalStatusText.includes('test-a'), false);
  assert.equal(logicalStatusText.includes('tomato_tap_relay_a'), false);

  const inventory = await requestJsonGet(proxyPort, '/models?model=balanced&task=structured-generation');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.count, 1);
  assert.equal(inventory.body.data[0].id, 'balanced');
  assert.equal(inventory.body.data[0].owned_by, 'tomato-tap-logical');
  assert.equal(inventory.body.data[0].health, 'probing');
  assert.equal(inventory.body.data[0].requested_task, 'structured-generation');
  assert.equal(inventory.body.data[0].ready_deployments, 0);
  assert.ok(inventory.body.data[0].probing_deployments > 0);

  const routeInventory = await requestJsonGet(proxyPort, '/oa/v1/models?model=balanced&task=structured-generation');
  assert.equal(routeInventory.status, 200);
  assert.equal(routeInventory.body.data.some((model) => model.id === 'balanced'), true);

  const malformedPayload = Buffer.from(JSON.stringify({ model: 'balanced', messages: [] }));
  const malformed = await requestRaw(
    proxyPort,
    '/oa/v1/chat/completions',
    'POST',
    malformedPayload,
    { 'content-type': 'application/json', 'content-length': String(malformedPayload.length), 'x-mimo-task': 'structured-generation' },
  );
  assert.equal(malformed.status, 400);
  assert.equal(calls.a, 0);
  assert.equal(calls.b, 0);

  const oversized = await requestJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced',
    messages: [{ role: 'user', content: 'x'.repeat(5000) }],
  });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.body.error.type, 'mimo_tap_invalid_logical_request');
  assert.match(oversized.body.error.message, /input budget exceeded/i);
  assert.equal(calls.a, 0);
  assert.equal(calls.b, 0);

  const started = Date.now();
  const response = await requestJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced',
    messages: [{ role: 'user', content: 'generate' }],
  }, { 'x-mimo-task': 'structured-generation', 'x-mimo-deadline-ms': '5000' });
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200, output.join(''));
  assert.equal(response.body.choices[0].message.content, 'ok');
  assert.equal(response.body.model, 'real-b');
  assert.equal(response.body.mimo_tap.attempts, 2);
  assert.equal(response.body.mimo_tap.requested_model, 'balanced');
  // real-b has the higher weight and lower configured latency, but ordered
  // routing tries real-a first and falls back to real-b only after the
  // real-a deployment is excluded.
  assert.equal(response.headers['x-mimo-resolved-model'], 'real-b');
  assert.equal(headersA['x-mimo-task'], undefined);
  assert.equal(headersA['x-mimo-deadline-ms'], undefined);
  assert.equal(calls.a, 1);
  assert.equal(calls.b, 1);
  assert.equal(calls.c, 0);
  assert.ok(elapsed < 5000, `logical dispatch took ${elapsed}ms`);
  const qualified = await requestJsonGet(proxyPort, '/models?available=1&model=balanced&task=structured-generation');
  assert.equal(qualified.body.count, 1);
  assert.ok(qualified.body.data[0].ready_deployments > 0);

  holdNextA = true;
  const directPromise = requestJson(proxyPort, '/direct/v1/chat/completions', {
    model: 'real-a',
    messages: [{ role: 'user', content: 'hold model slot' }],
  });
  await waitFor(() => pendingA !== null, 1000);
  const sharedCap = await requestJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced',
    messages: [{ role: 'user', content: 'respect shared model cap' }],
  }, { 'x-mimo-task': 'structured-generation' });
  assert.equal(sharedCap.status, 200);
  assert.equal(sharedCap.body.model, 'real-b');
  assert.equal(sharedCap.body.mimo_tap.attempts, 1);
  assert.equal(calls.a, 2);
  pendingA.writeHead(200, { 'content-type': 'application/json' });
  pendingA.end(JSON.stringify({ model: 'real-a', choices: [{ message: { content: 'released' } }] }));
  await directPromise;
  pendingA = null;

  holdNextA = true;
  holdNextB = true;
  const busyDirectA = requestJson(proxyPort, '/direct/v1/chat/completions', {
    model: 'real-a', messages: [{ role: 'user', content: 'hold a' }],
  });
  const busyDirectB = requestJson(proxyPort, '/direct/v1/chat/completions', {
    model: 'real-b', messages: [{ role: 'user', content: 'hold b' }],
  });
  await waitFor(() => pendingA !== null && pendingB !== null, 1000);
  const waitsForCapacity = requestJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced', messages: [{ role: 'user', content: 'wait for a healthy slot' }],
  }, { 'x-mimo-task': 'structured-generation', 'x-mimo-deadline-ms': '2000' });
  await delay(150);
  pendingB.writeHead(200, { 'content-type': 'application/json' });
  pendingB.end(JSON.stringify({ model: 'real-b', choices: [{ message: { content: 'direct b released' } }] }));
  const waitedResponse = await waitsForCapacity;
  assert.equal(waitedResponse.status, 200);
  assert.equal(waitedResponse.body.model, 'real-b');
  pendingA.writeHead(200, { 'content-type': 'application/json' });
  pendingA.end(JSON.stringify({ model: 'real-a', choices: [{ message: { content: 'direct a released' } }] }));
  await Promise.all([busyDirectA, busyDirectB]);
  pendingA = null;
  pendingB = null;

  abortMode = true;
  const beforeAbortStatus = await requestJsonGet(proxyPort, '/__status');
  const abortedRequest = startAbortableLogicalRequest(proxyPort);
  await waitFor(() => abortSeen > 0, 1000);
  abortedRequest.destroy();
  await waitForAsync(async () => {
    const current = await requestJsonGet(proxyPort, '/__status');
    return Object.keys(current.body.logical_scheduler.model_inflight).length === 0
      && Object.keys(current.body.logical_scheduler.runtime.activeByLogical).length === 0;
  }, 500);
  const afterAbortStatus = await requestJsonGet(proxyPort, '/__status');
  assert.deepEqual(
    afterAbortStatus.body.logical_scheduler.runtime.pairs,
    beforeAbortStatus.body.logical_scheduler.runtime.pairs,
  );
  assert.deepEqual(
    afterAbortStatus.body.key_pool.map((key) => key.outcomes_last_32),
    beforeAbortStatus.body.key_pool.map((key) => key.outcomes_last_32),
  );
  abortMode = false;

  rateLimit = true;
  const exhausted = await requestJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced',
    messages: [{ role: 'user', content: 'generate' }],
  }, { 'x-mimo-task': 'structured-generation' });
  assert.equal(exhausted.status, 503);
  assert.equal(exhausted.body.error.type, 'mimo_tap_logical_exhausted');
  const unavailable = await requestJsonGet(proxyPort, '/models?available=1&model=balanced&task=structured-generation');
  assert.equal(unavailable.body.count, 0);
  console.log('All logical-dispatch tests passed.');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([onceExit(child), delay(1000)]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  await Promise.all([closeServer(upstreamA.server), closeServer(upstreamB.server), closeServer(upstreamC.server)]);
  rmSync(temp, { recursive: true, force: true });
}

function realModel() {
  return {
    qualityTier: 'strong',
    capabilities: ['strict_json', 'structured_output', 'long_output'],
    thinkingAdapter: 'none',
    maxInflight: 1,
    initialLatencyMs: 100,
    firstByteTimeoutMs: 1000,
    totalTimeoutMs: 2000,
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, port: server.address().port };
}

async function freePort() {
  const holder = await startServer((_req, res) => res.end());
  const port = holder.port;
  await closeServer(holder.server);
  return port;
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function collectBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function waitUntilReady(port, processHandle, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode != null) {
      throw new Error(`proxy exited ${processHandle.exitCode}:\n${output.join('')}`);
    }
    try {
      const result = await requestRaw(port, '/__status', 'GET');
      if (result.status === 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`proxy did not become ready:\n${output.join('')}`);
}

async function requestJson(port, path, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const response = await requestRaw(port, path, 'POST', payload, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    ...extraHeaders,
  });
  return { ...response, body: JSON.parse(response.body.toString('utf8')) };
}

async function requestJsonGet(port, path) {
  const response = await requestRaw(port, path, 'GET');
  return { ...response, body: JSON.parse(response.body.toString('utf8')) };
}

function requestRaw(port, path, method, body = null, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(6000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function onceExit(processHandle) {
  return new Promise((resolveExit) => processHandle.once('exit', resolveExit));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('condition not reached before timeout');
}

async function waitForAsync(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('async condition not reached before timeout');
}

function startAbortableLogicalRequest(port) {
  const payload = Buffer.from(JSON.stringify({
    model: 'balanced',
    messages: [{ role: 'user', content: 'abort me' }],
  }));
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/oa/v1/chat/completions',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.length),
      'x-mimo-task': 'structured-generation',
    },
  });
  req.on('error', () => {});
  req.write(payload);
  req.end();
  return req;
}
