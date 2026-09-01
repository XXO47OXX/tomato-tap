import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('direct route waits through 429 and honors its longer vendor timeout', async () => {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const temp = mkdtempSync(join(tmpdir(), 'mimo-direct-429-'));
  const proxyPort = await freePort();
  let upstreamCalls = 0;
  const upstream = await startServer(async (req, res) => {
    await collectBody(req);
    upstreamCalls++;
    if (upstreamCalls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.15' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
      return;
    }
    await delay(1200);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg-test', type: 'message', role: 'assistant', model: 'kimi-k3',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 1 },
    }));
  });
  let child;
  const output = [];

  try {
    const envPath = join(temp, '.env');
    const vendorsPath = join(temp, 'vendors.json');
    const relaysPath = join(temp, 'relays.json');
    const modelsPath = join(temp, 'models.json');
    writeFileSync(vendorsPath, JSON.stringify({
      schemaVersion: 1,
      vendors: [{
        id: 'direct', envDiscovery: 'multi', envPrefix: '^tomato_tap_relay_(.+?)_key$',
        unboundedModelConcurrency: true, unboundedKeyConcurrency: true,
        retryPolicy: { waitFor429RecoveryMs: 500 },
        requestTimeouts: { firstByteMs: 1500, totalMs: 2500 },
        routes: [{
          prefix: '/direct/v1/messages', apiFormat: 'anthropic', auth: 'bearer',
          rewrite: { from: '^/direct/v1/messages', to: '/v1/messages' },
        }],
      }],
    }));
    writeFileSync(relaysPath, JSON.stringify({
      schemaVersion: 1,
      relays: {
        kimi: {
          host: '127.0.0.1', proto: 'http', port: upstream.port, path: '/coding',
          apiFormats: ['anthropic'], models: ['kimi-k3'], proxy: false,
          cap: { initial: 20, min: 20, max: 20 },
        },
      },
    }));
    writeFileSync(modelsPath, JSON.stringify(modelPolicy()));
    writeFileSync(envPath, 'tomato_tap_relay_kimi_key=test-key\n');

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
        TOMATO_TAP_ORDINARY_FIRST_BYTE_TIMEOUT: '1s',
        TOMATO_TAP_ORDINARY_TOTAL_TIMEOUT: '1s',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    await waitFor(async () => (await getJson(proxyPort, '/__status')).status === 200, 5000, output);

    const started = Date.now();
    const response = await postJson(proxyPort, '/direct/v1/messages', {
      model: 'kimi-k3', max_tokens: 32,
      messages: [{ role: 'user', content: 'reply ok' }],
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200, output.join(''));
    assert.equal(response.body.content[0].text, 'ok');
    assert.equal(upstreamCalls, 2);
    assert.ok(elapsed >= 125, `expected a cooldown wait, elapsed=${elapsed}ms`);
    assert.match(output.join(''), /WAIT route-429-recovery key=tomato_tap_relay_kimi/);
  } finally {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([onceExit(child), delay(3000)]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    await new Promise((resolveClose) => upstream.server.close(resolveClose));
    rmSync(temp, { recursive: true, force: true });
  }
});

function modelPolicy() {
  const real = {
    qualityTier: 'strong', capabilities: ['strict_json'], thinkingAdapter: 'none',
    maxInflight: 20, initialLatencyMs: 10, firstByteTimeoutMs: 1000, totalTimeoutMs: 2000,
  };
  return {
    schemaVersion: 1,
    realModels: { 'kimi-k3': real },
    taskSubtypes: {
      'test-task': {
        candidates: ['kimi-k3'], requiredCapabilities: [],
        maxAttempts: 1, deadlineMs: 1000,
      },
    },
    logicalModels: {
      test: {
        candidates: ['kimi-k3'], requiredCapabilities: [], allowedTaskSubtypes: ['test-task'],
        maxInflight: 1, maxAttempts: 1, deadlineMs: 1000,
      },
    },
  };
}

function startServer(handler) {
  return new Promise((resolveStart) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolveStart({ server, port: server.address().port }));
  });
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

function getJson(port, path) {
  return requestJson(port, path, 'GET');
}

function postJson(port, path, body) {
  return requestJson(port, path, 'POST', body);
}

function requestJson(port, path, method, body) {
  return new Promise((resolveRequest) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: payload ? {
        authorization: 'Bearer local-test',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* readiness path */ }
        resolveRequest({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', () => resolveRequest({ status: 0, body: null }));
    if (payload) req.end(payload); else req.end();
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
  return new Promise((resolveBody) => {
    req.resume();
    req.on('end', resolveBody);
  });
}

function onceExit(process) {
  return new Promise((resolveExit) => process.once('exit', resolveExit));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
