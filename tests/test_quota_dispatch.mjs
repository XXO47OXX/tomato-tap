import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createQuotaControlClient } from '../src/providers/quota/quota-control.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'mimo-quota-dispatch-'));
const calls = { closed: 0, kimi: 0, fallback: 0, quota429: 0 };
let child;
let failClosedChild;

const closedUpstream = await startServer((_req, res) => {
  calls.closed++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    model: 'real-closed',
    choices: [{ message: { content: 'must-not-run' } }],
  }));
});
const kimiUpstream = await startServer((_req, res) => {
  calls.kimi++;
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      type: 'access_terminated_error',
      message: 'You have reached usage limit for this billing cycle. It will be refreshed in next cycle.',
    },
  }));
});
const fallbackUpstream = await startServer((_req, res) => {
  calls.fallback++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    model: 'real-fallback',
    choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  }));
});
const quota429Upstream = await startServer((_req, res) => {
  calls.quota429++;
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
  res.end(JSON.stringify({ error: { message: 'rate limited' } }));
});

try {
  const proxyPort = await freePort();
  const policyPath = join(temp, 'models.json');
  const relaysPath = join(temp, 'relays.json');
  const vendorsPath = join(temp, 'vendors.json');
  const envPath = join(temp, '.env');
  const quotaStatePath = join(temp, 'quota-state', 'quota-windows.json');
  const quotaSocketPath = join(temp, 'runtime', 'quota-control.sock');

  writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1,
    realModels: {
      'real-closed': realModel(),
      'real-kimi': realModel(),
      'real-fallback': realModel(),
      'real-quota429': realModel(),
    },
    taskSubtypes: {
      'classifier-default': {
        requiredCapabilities: ['strict_json', 'domain_context'],
        candidates: ['real-kimi', 'real-fallback'],
        maxAttempts: 3,
        deadlineMs: 3000,
      },
    },
    logicalModels: {
      classifier: {
        requiredCapabilities: ['strict_json', 'domain_context'],
        candidates: ['real-kimi', 'real-fallback'],
        candidateStrategy: 'ordered',
        allowedTaskSubtypes: ['classifier-default'],
        maxInflight: 2,
        maxAttempts: 3,
        deadlineMs: 3000,
      },
    },
  }));
  writeFileSync(relaysPath, JSON.stringify({
    schemaVersion: 1,
    relays: {
      closed: {
        host: '127.0.0.1',
        proto: 'http',
        port: closedUpstream.port,
        path: '/v1',
        models: ['real-closed'],
        cap: { initial: 1, min: 1, max: 1 },
        quota: quotaPolicy('closed', 'real-closed'),
      },
      kimicode2: {
        host: '127.0.0.1',
        proto: 'http',
        port: kimiUpstream.port,
        path: '/v1',
        models: ['real-kimi'],
        cap: { initial: 1, min: 1, max: 1 },
        quota: quotaPolicy('open', 'real-kimi'),
      },
      fallback: {
        host: '127.0.0.1',
        proto: 'http',
        port: fallbackUpstream.port,
        path: '/v1',
        models: ['real-fallback'],
        cap: { initial: 1, min: 1, max: 1 },
      },
      quota429: {
        host: '127.0.0.1',
        proto: 'http',
        port: quota429Upstream.port,
        path: '/v1',
        models: ['real-quota429'],
        cap: { initial: 4, min: 1, max: 4 },
        quota: quotaPolicy('open', 'real-quota429'),
      },
    },
  }));
  writeFileSync(vendorsPath, JSON.stringify({
    schemaVersion: 1,
    vendors: [{
      id: 'relay',
      envDiscovery: 'multi',
      envPrefix: '^tomato_tap_relay_(.+?)_key$',
      routes: [{
        prefix: '/oa/v1',
        apiFormat: 'openai',
        auth: 'bearer',
        rewrite: { from: '^/oa/v1', to: '' },
      }],
    }],
  }));
  writeFileSync(envPath, [
    'tomato_tap_relay_closed_key=sk-test-closed',
    'tomato_tap_relay_kimicode2_key=sk-test-kimi',
    'tomato_tap_relay_fallback_key=sk-test-fallback',
    'tomato_tap_relay_quota429_key=sk-test-quota429',
    '',
  ].join('\n'));

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
      TOMATO_TAP_QUOTA_STATE_PATH: quotaStatePath,
      TOMATO_TAP_QUOTA_SOCKET_PATH: quotaSocketPath,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitUntilReady(proxyPort, child, output);

  const initial = await getJson(proxyPort, '/__status');
  assert.equal(initial.body.quota_windows.find((item) => item.deploymentId === 'closed').state, 'closed');
  assert.equal(initial.body.quota_windows.find((item) => item.deploymentId === 'kimicode2').state, 'open');
  assert.equal(existsSync(quotaSocketPath), true);

  const closedResponse = await postJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'real-closed',
    messages: [{ role: 'user', content: 'do not dispatch' }],
  });
  assert.equal(closedResponse.status, 503);
  assert.equal(calls.closed, 0);

  const logical = await postJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'classifier',
    messages: [{ role: 'user', content: 'classify' }],
  });
  assert.equal(logical.status, 200, output.join(''));
  assert.equal(logical.body.model, 'real-fallback');
  assert.equal(logical.body.mimo_tap.attempts, 2);
  assert.equal(calls.kimi, 1);
  assert.equal(calls.fallback, 1);

  const afterQuota = await getJson(proxyPort, '/__status');
  const kimiWindow = afterQuota.body.quota_windows.find((item) => item.deploymentId === 'kimicode2');
  assert.equal(kimiWindow.state, 'closed');
  assert.equal(kimiWindow.closedReason, 'kimi-billing-cycle');
  assert.ok(kimiWindow.nextProbeAt > Date.now());
  assert.equal(JSON.stringify(afterQuota.body).includes('sk-test'), false);

  const directAfterClosed = await postJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'real-kimi',
    messages: [{ role: 'user', content: 'do not dispatch twice' }],
  });
  assert.equal(directAfterClosed.status, 503);
  assert.equal(calls.kimi, 1);
  assert.equal(existsSync(quotaStatePath), true);

  const rateLimited = await postJson(proxyPort, '/oa/v1/chat/completions', {
    model: 'real-quota429',
    messages: [{ role: 'user', content: 'close this quota window' }],
  });
  assert.equal(rateLimited.status, 503);
  assert.equal(calls.quota429, 1);
  const after429 = await getJson(proxyPort, '/__status');
  const quota429Key = after429.body.key_pool.find(
    (entry) => entry.name === 'tomato_tap_relay_quota429',
  );
  assert.equal(quota429Key.cap, 2);
  assert(quota429Key.cooldown_remaining_ms > 0);

  const quotaClient = createQuotaControlClient({ socketPath: quotaSocketPath, timeoutMs: 1000 });
  const claimResponse = await quotaClient.request({
    id: 'claim-reopen',
    method: 'claim_due',
    now: Date.now() + 61_000,
    limit: 8,
  });
  const quotaClaim = claimResponse.claims.find(
    (claim) => claim.deploymentId === 'quota429',
  );
  assert(quotaClaim);
  const quotaStateDirectory = dirname(quotaStatePath);
  const savedQuotaStateDirectory = `${quotaStateDirectory}-saved`;
  renameSync(quotaStateDirectory, savedQuotaStateDirectory);
  writeFileSync(quotaStateDirectory, 'block persistence temporarily');
  const failedPersistResponse = await quotaClient.request({
    id: 'report-reopen',
    method: 'report_probe',
    deploymentId: 'quota429',
    claimToken: quotaClaim.claimToken,
    valid: true,
    status: 200,
    quotaSignal: null,
    observedAt: Date.now() + 61_100,
  });
  assert.equal(failedPersistResponse.ok, false);
  const reconciledBeforePersistence = await getJson(proxyPort, '/__status');
  const reconciledKey = reconciledBeforePersistence.body.key_pool.find(
    (entry) => entry.name === 'tomato_tap_relay_quota429',
  );
  assert.equal(reconciledBeforePersistence.body.quota_persistence_healthy, false);
  assert.equal(reconciledKey.cap, 4);
  assert.equal(reconciledKey.cooldown_remaining_ms, 0);

  rmSync(quotaStateDirectory);
  renameSync(savedQuotaStateDirectory, quotaStateDirectory);
  const reopenResponse = await quotaClient.request({
    id: 'report-reopen-retry',
    method: 'report_probe',
    deploymentId: 'quota429',
    claimToken: quotaClaim.claimToken,
    valid: true,
    status: 200,
    quotaSignal: null,
    observedAt: Date.now() + 61_100,
  });
  assert.equal(reopenResponse.ok, true);
  assert.equal(reopenResponse.accepted, false);
  const reopened = await getJson(proxyPort, '/__status');
  const reopenedWindow = reopened.body.quota_windows.find(
    (entry) => entry.deploymentId === 'quota429',
  );
  const reopenedKey = reopened.body.key_pool.find(
    (entry) => entry.name === 'tomato_tap_relay_quota429',
  );
  assert.equal(reopenedWindow.state, 'boosted');
  assert.equal(reopenedKey.cap, 4);
  assert.equal(reopenedKey.cooldown_remaining_ms, 0);

  const failClosedPort = await freePort();
  const blockedParent = join(temp, 'not-a-directory');
  writeFileSync(blockedParent, 'block state directory creation');
  const failOutput = [];
  failClosedChild = spawn(process.execPath, ['proxy.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      PORT: String(failClosedPort),
      TOMATO_TAP_ENV_FILE: envPath,
      TOMATO_TAP_MODELS_PATH: policyPath,
      TOMATO_TAP_RELAYS_PATH: relaysPath,
      TOMATO_TAP_VENDORS_PATH: vendorsPath,
      TOMATO_TAP_STATE_DIR: temp,
      TOMATO_TAP_QUOTA_STATE_PATH: join(blockedParent, 'quota-windows.json'),
      TOMATO_TAP_QUOTA_SOCKET_PATH: join(temp, 'runtime-fail', 'quota-control.sock'),
      TOMATO_TAP_QUOTA_PERSIST_RETRY_MS: '50',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  failClosedChild.stdout.on('data', (chunk) => failOutput.push(chunk.toString()));
  failClosedChild.stderr.on('data', (chunk) => failOutput.push(chunk.toString()));
  await waitUntilReady(failClosedPort, failClosedChild, failOutput);
  const failStatus = await getJson(failClosedPort, '/__status');
  assert.equal(failStatus.body.quota_persistence_healthy, false);
  const callsBeforeUnmanaged = calls.fallback;
  const unmanagedDuringPersistenceFailure = await postJson(
    failClosedPort,
    '/oa/v1/chat/completions',
    {
      model: 'real-fallback',
      messages: [{ role: 'user', content: 'unmanaged remains available' }],
    },
  );
  assert.equal(unmanagedDuringPersistenceFailure.status, 200);
  assert.equal(calls.fallback, callsBeforeUnmanaged + 1);

  const callsBeforeFailClosed = calls.kimi;
  const blockedByPersistence = await postJson(failClosedPort, '/oa/v1/chat/completions', {
    model: 'real-kimi',
    messages: [{ role: 'user', content: 'must fail closed' }],
  });
  assert.equal(blockedByPersistence.status, 503);
  assert.equal(calls.kimi, callsBeforeFailClosed);

  rmSync(blockedParent);
  mkdirSync(blockedParent, { mode: 0o700 });
  await waitForCondition(async () => {
    const status = await getJson(failClosedPort, '/__status');
    return status.body.quota_persistence_healthy === true;
  }, 2000);
  await postJson(failClosedPort, '/oa/v1/chat/completions', {
    model: 'real-kimi',
    messages: [{ role: 'user', content: 'managed dispatch recovers' }],
  });
  assert.equal(calls.kimi, callsBeforeFailClosed + 1);

  console.log('All quota-dispatch tests passed.');
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([onceExit(child), delay(1500)]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (failClosedChild && failClosedChild.exitCode == null) {
    failClosedChild.kill('SIGTERM');
    await Promise.race([onceExit(failClosedChild), delay(1500)]);
    if (failClosedChild.exitCode == null) failClosedChild.kill('SIGKILL');
  }
  await Promise.all([
    closeServer(closedUpstream.server),
    closeServer(kimiUpstream.server),
    closeServer(fallbackUpstream.server),
    closeServer(quota429Upstream.server),
  ]);
  rmSync(temp, { recursive: true, force: true });
}

function quotaPolicy(initialState, probeModel) {
  return {
    initialState,
    probeModel,
    probeIntervalMs: 300_000,
    boostWindowMs: 18_000_000,
    boostWeight: 4,
    probeMaxTokens: 128,
  };
}

function realModel() {
  return {
    qualityTier: 'strong',
    capabilities: ['strict_json', 'domain_context'],
    thinkingAdapter: 'none',
    maxInflight: 2,
    initialLatencyMs: 10,
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

function request(port, path, method, body = null) {
  return new Promise((resolveRequest, rejectRequest) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        resolveRequest({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', rejectRequest);
    if (payload) req.end(payload);
    else req.end();
  });
}

function getJson(port, path) {
  return request(port, path, 'GET');
}

function postJson(port, path, body) {
  return request(port, path, 'POST', body);
}

async function waitUntilReady(port, processHandle, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode != null) {
      throw new Error(`proxy exited ${processHandle.exitCode}:\n${output.join('')}`);
    }
    try {
      const response = await getJson(port, '/__status');
      if (response.status === 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`proxy did not become ready:\n${output.join('')}`);
}

function onceExit(processHandle) {
  return new Promise((resolveExit) => processHandle.once('exit', resolveExit));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}
