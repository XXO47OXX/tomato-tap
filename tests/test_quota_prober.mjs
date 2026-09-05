import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  buildProbeHeaders,
  createQuotaProber,
  PROBE_TICK_MS,
} from '../src/providers/quota/quota-prober.mjs';

assert.equal(buildProbeHeaders({
  value: 'bearer-value', authType: 'bearer', headers: { 'x-client-type': 'cli' },
}, { anthropic: true, bodyLength: 12 }).authorization, 'Bearer bearer-value');
assert.equal(buildProbeHeaders({
  value: 'x-api-value', authType: 'x-api-key',
}, { anthropic: true, bodyLength: 12 })['x-api-key'], 'x-api-value');
assert.throws(() => buildProbeHeaders({
  value: 'bad', authType: 'basic',
}, { anthropic: false, bodyLength: 1 }), /unsupported probe auth policy/);

let mode = 'valid';
let upstreamCalls = 0;
const upstream = http.createServer((req, res) => {
  upstreamCalls++;
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.url, '/coding/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer secret-value');
    assert.equal(body.model, 'k3');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    if (mode === 'valid') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'k3',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      }));
      return;
    }
    if (mode === 'wrapped') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not actually available' } }));
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'access_terminated_error',
        message: 'You have reached usage limit for this billing cycle.',
      },
    }));
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const port = upstream.address().port;

const reports = [];
let claimNumber = 0;
const controlClient = {
  async request(message) {
    if (message.method === 'claim_due') {
      claimNumber++;
      return {
        ok: true,
        claims: [{
          deploymentId: 'kimicode2',
          claimToken: `claim-${claimNumber}`,
          probeModel: 'k3',
          probeMaxTokens: 256,
        }],
      };
    }
    reports.push(message);
    return { ok: true, accepted: true };
  },
};
const logs = [];
const prober = createQuotaProber({
  controlClient,
  deployments: new Map([[
    'kimicode2',
    {
      deploymentId: 'kimicode2',
      name: 'tomato_tap_relay_kimicode2',
      value: 'secret-value',
      host: '127.0.0.1',
      pathPrefix: '/coding/v1',
      proto: 'http',
      port,
      thinkingAdapter: 'longcat_disabled',
    },
  ]]),
  maxConcurrency: 2,
  timeoutMs: 1000,
  logger: (line) => logs.push(line),
});

assert.equal(PROBE_TICK_MS, 15_000);

await prober.tick();
assert.equal(reports[0].valid, true);
assert.equal(reports[0].status, 200);
assert.equal(reports[0].quotaSignal, null);

mode = 'wrapped';
await prober.tick();
assert.equal(reports[1].valid, false);
assert.equal(reports[1].failureClass, 'wrapped_error');

mode = 'quota';
await prober.tick();
assert.equal(reports[2].valid, false);
assert.equal(reports[2].status, 403);
assert.equal(reports[2].quotaSignal.label, 'kimi-billing-cycle');
assert.equal(reports[2].quotaSignal.retryAfterMs, 6 * 60 * 60 * 1000);

assert.equal(upstreamCalls, 3);
assert.equal(logs.join('\n').includes('secret-value'), false);
assert.equal(logs.join('\n').includes('reached usage limit'), false);

let retryReports = 0;
const retryProber = createQuotaProber({
  controlClient: {
    async request(message) {
      if (message.method === 'claim_due') {
        return {
          ok: true,
          claims: [{
            deploymentId: 'kimicode2',
            claimToken: 'retry-claim',
            probeModel: 'k3',
            probeMaxTokens: 256,
          }],
        };
      }
      retryReports++;
      if (retryReports === 1) return { ok: false, error: 'state is not durable' };
      if (retryReports === 2) throw new Error('socket temporarily unavailable');
      return { ok: true, accepted: true };
    },
  },
  deployments: new Map([[
    'kimicode2',
    {
      deploymentId: 'kimicode2',
      name: 'tomato_tap_relay_kimicode2',
      value: 'secret-value',
      host: '127.0.0.1',
      pathPrefix: '/coding/v1',
      proto: 'http',
      port,
      thinkingAdapter: 'longcat_disabled',
    },
  ]]),
  timeoutMs: 1000,
  reportRetryMs: 1,
  logger: () => {},
});
mode = 'valid';
await retryProber.tick();
assert.equal(retryReports, 3);

const callsBeforeExpiredProbe = upstreamCalls;
const expiredReports = [];
const expiredProber = createQuotaProber({
  controlClient: {
    async request(message) {
      if (message.method === 'claim_due') {
        return {
          ok: true,
          claims: [{
            deploymentId: 'expired-plan',
            claimToken: 'expired-claim',
            probeModel: 'k3',
            probeMaxTokens: 256,
          }],
        };
      }
      expiredReports.push(message);
      return { ok: true, accepted: true };
    },
  },
  deployments: new Map([[
    'expired-plan',
    {
      deploymentId: 'expired-plan',
      name: 'tomato_tap_relay_expired_plan',
      value: 'secret-value',
      host: '127.0.0.1',
      pathPrefix: '/coding/v1',
      proto: 'http',
      port,
      thinkingAdapter: 'none',
      expiresAtMs: Date.now() - 1000,
    },
  ]]),
  timeoutMs: 1000,
  logger: () => {},
});
await expiredProber.tick();
assert.equal(upstreamCalls, callsBeforeExpiredProbe);
assert.equal(expiredReports[0].status, 410);
assert.equal(expiredReports[0].valid, false);
assert.equal(expiredReports[0].failureClass, 'expired');

await new Promise((resolve) => upstream.close(resolve));

let anthropicCalls = 0;
const anthropicUpstream = http.createServer((req, res) => {
  anthropicCalls++;
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.url, '/coding/v1/messages');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers.authorization, 'Bearer secret-anthropic');
    assert.equal(body.model, 'k3-256k');
    assert.equal(body.reasoning_effort, 'low');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '{"ok":true}' }],
    }));
  });
});
await new Promise((resolve) => anthropicUpstream.listen(0, '127.0.0.1', resolve));
const anthropicPort = anthropicUpstream.address().port;

let proxyConnects = 0;
const proxySockets = new Set();
const fixedProxy = http.createServer();
fixedProxy.on('connection', (socket) => {
  proxySockets.add(socket);
  socket.once('close', () => proxySockets.delete(socket));
});
fixedProxy.on('connect', (req, clientSocket, head) => {
  proxyConnects++;
  const separator = req.url.lastIndexOf(':');
  const host = req.url.slice(0, separator);
  const targetPort = Number(req.url.slice(separator + 1));
  const targetSocket = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });
  targetSocket.once('error', () => clientSocket.destroy());
});
await new Promise((resolve) => fixedProxy.listen(0, '127.0.0.1', resolve));
const fixedProxyPort = fixedProxy.address().port;

const anthropicReports = [];
const anthropicProber = createQuotaProber({
  controlClient: {
    async request(message) {
      if (message.method === 'claim_due') {
        return { ok: true, claims: [{
          deploymentId: 'anthropic-example', claimToken: 'claim',
          probeModel: 'k3-256k', probeMaxTokens: 32,
        }] };
      }
      anthropicReports.push(message);
      return { ok: true, accepted: true };
    },
  },
  deployments: new Map([['anthropic-example', {
    deploymentId: 'anthropic-example',
    name: 'tomato_tap_relay_anthropic_example',
    value: 'secret-anthropic',
    host: '127.0.0.1',
    pathPrefix: '/coding',
    proto: 'http',
    port: anthropicPort,
    proxyUrl: `http://127.0.0.1:${fixedProxyPort}`,
    apiFormats: new Set(['anthropic', 'openai']),
    authType: 'bearer',
    quotaSignalProfile: 'kimi-coding',
    thinkingAdapter: 'none',
  }]]),
  timeoutMs: 1000,
  logger: () => {},
});
await anthropicProber.tick();
assert.equal(anthropicCalls, 1);
assert.equal(proxyConnects, 1);
assert.equal(anthropicReports[0].valid, true);
assert.equal(anthropicReports[0].status, 200);
for (const socket of proxySockets) socket.destroy();
await new Promise((resolve) => fixedProxy.close(resolve));
await new Promise((resolve) => anthropicUpstream.close(resolve));

console.log('All quota-prober tests passed.');
