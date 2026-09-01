import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'tomato-runtime-reload-'));
const proxyPort = await freePort();
const observedHeaders = [];
const upstream = await startServer(async (req, res) => {
  observedHeaders.push(req.headers);
  await collectBody(req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    model: 'real-a',
    choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  }));
});
let child;

const envPath = join(temp, '.env');
const vendorsPath = join(temp, 'vendors.json');
const relaysPath = join(temp, 'relays.json');
const modelsPath = join(temp, 'models.json');

try {
  writeFileSync(vendorsPath, JSON.stringify({
    schemaVersion: 1,
    vendors: [{
      id: 'relay', envDiscovery: 'multi', envPrefix: '^tomato_tap_relay_(.+?)_key$',
      routes: [{
        prefix: '/oa/v1', apiFormat: 'openai', auth: 'bearer',
        rewrite: { from: '^/oa/v1', to: '' },
      }],
    }],
  }));
  writeFileSync(modelsPath, JSON.stringify(modelPolicy()));
  writeFileSync(relaysPath, JSON.stringify(relayRegistry(upstream.port, ['a'])));
  writeFileSync(envPath, 'tomato_tap_relay_a_key=key-a\n');

  const output = [];
  child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      PORT: String(proxyPort),
      TOMATO_TAP_ENV_FILE: envPath,
      TOMATO_TAP_MODELS_PATH: modelsPath,
      TOMATO_TAP_RELAYS_PATH: relaysPath,
      TOMATO_TAP_VENDORS_PATH: vendorsPath,
      TOMATO_TAP_STATE_DIR: temp,
      TOMATO_TAP_CONFIG_RELOAD_MS: '250',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitFor(async () => (await getJson(proxyPort, '/__status')).status === 200, 5000, output);

  const initial = await getJson(proxyPort, '/__status');
  assert.equal(initial.body.key_pool.length, 1);
  const initialRevision = initial.body.runtime_config.active_revision;

  const inventory = await getJson(proxyPort, '/models?model=balanced&details=eligibility');
  assert.equal(inventory.body.data[0].qualification.state, 'probing');
  assert.equal(inventory.body.data[0].candidate_eligibility.length, 1);
  assert.equal(JSON.stringify(inventory.body).includes('key-a'), false);

  const completion = await postJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'balanced', messages: [{ role: 'user', content: 'return json' }],
  });
  assert.equal(completion.status, 200);
  assert.equal(observedHeaders.at(-1)['x-api-key'], 'key-a');
  assert.equal(observedHeaders.at(-1).authorization, undefined);
  assert.equal(observedHeaders.at(-1)['user-agent'], 'supported-client/1.0');

  writeFileSync(relaysPath, JSON.stringify(relayRegistry(upstream.port, ['a', 'b'])));
  writeFileSync(envPath, 'tomato_tap_relay_a_key=key-a\ntomato_tap_relay_b_key=key-b\n');
  await waitFor(async () => {
    const status = await getJson(proxyPort, '/__status');
    return status.body.key_pool.length === 2
      && status.body.runtime_config.active_revision !== initialRevision;
  }, 5000, output);

  const reloaded = await getJson(proxyPort, '/__status');
  const activeRevision = reloaded.body.runtime_config.active_revision;
  assert.equal(reloaded.body.runtime_config.reload_count, 1);
  assert.equal(reloaded.body.runtime_config.pending_revision, null);

  writeFileSync(modelsPath, '{broken');
  await waitFor(async () => {
    const status = await getJson(proxyPort, '/__status');
    return !!status.body.runtime_config.last_error;
  }, 5000, output);
  const rejected = await getJson(proxyPort, '/__status');
  assert.equal(rejected.body.runtime_config.active_revision, activeRevision);
  assert.equal(rejected.body.key_pool.length, 2);

  console.log('test_runtime_reload: ok');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([onceExit(child), delay(3000)]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  await new Promise((resolve) => upstream.server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}

function modelPolicy() {
  const real = {
    qualityTier: 'strong', capabilities: ['strict_json'], thinkingAdapter: 'none',
    maxInflight: 2, initialLatencyMs: 10, firstByteTimeoutMs: 1000, totalTimeoutMs: 2000,
  };
  return {
    schemaVersion: 1,
    realModels: { 'real-a': real },
    taskSubtypes: {
      'structured-test': {
        candidates: ['real-a'], requiredCapabilities: ['strict_json'], maxAttempts: 2, deadlineMs: 1000,
      },
    },
    logicalModels: {
      balanced: {
        candidates: ['real-a'], requiredCapabilities: ['strict_json'], allowedTaskSubtypes: ['structured-test'],
        maxInflight: 2, maxAttempts: 2, deadlineMs: 1000,
      },
    },
  };
}

function relayRegistry(port, ids) {
  return {
    schemaVersion: 1,
    relays: Object.fromEntries(ids.map((id) => [id, {
      host: '127.0.0.1', proto: 'http', port, path: '/v1', models: ['real-a'],
      auth: 'x-api-key', headers: { 'User-Agent': 'supported-client/1.0' },
      cap: { initial: 1, min: 1, max: 1 },
    }])),
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { /* readiness path */ }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
  });
}

function postJson(port, path, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });
}

async function waitFor(check, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`condition timed out\n${output.join('')}`);
}

function collectBody(req) {
  return new Promise((resolve) => {
    req.resume();
    req.on('end', resolve);
  });
}

function onceExit(process) {
  return new Promise((resolve) => process.once('exit', resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
