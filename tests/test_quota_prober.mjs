import assert from 'node:assert/strict';
import http from 'node:http';
import { createQuotaProber, PROBE_TICK_MS } from '../src/providers/quota/quota-prober.mjs';

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
console.log('All quota-prober tests passed.');
