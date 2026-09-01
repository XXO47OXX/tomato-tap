import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createUpstreamHttpTransport } from '../src/egress/upstream-http.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('upstream transport buffers an HTTP response and reports timings', async () => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(202, { 'content-type': 'application/json', 'x-method': req.method });
      res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  const port = await listen(upstream);
  const transport = createUpstreamHttpTransport();

  try {
    const result = await transport.sendBuffered(
      Buffer.from('payload'),
      'POST',
      '/v1/test',
      { 'content-type': 'text/plain', 'content-length': '7' },
      { proto: 'http', host: '127.0.0.1', port, vendor: 'test' },
      { firstByteTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
    );

    assert.equal(result.status, 202);
    assert.equal(result.networkError, null);
    assert.equal(result.headers['x-method'], 'POST');
    assert.deepEqual(JSON.parse(result.body), { path: '/v1/test', body: 'payload' });
    assert.ok(result.firstByteMs >= 0);
    assert.ok(result.elapsedMs >= result.firstByteMs);
  } finally {
    transport.close();
    await close(upstream);
  }
});

test('upstream transport turns a first-byte timeout into a network error', async () => {
  const upstream = http.createServer((_req, res) => {
    setTimeout(() => res.end('late'), 100);
  });
  const port = await listen(upstream);
  const transport = createUpstreamHttpTransport();

  try {
    const result = await transport.sendBuffered(
      Buffer.alloc(0),
      'GET',
      '/',
      {},
      { proto: 'http', host: '127.0.0.1', port, vendor: 'test' },
      { firstByteTimeoutMs: 20, totalTimeoutMs: 1_000 },
    );

    assert.equal(result.status, 0);
    assert.equal(result.networkError?.code, 'ETIMEDOUT');
    assert.match(result.networkError?.message || '', /first-byte timeout/);
  } finally {
    transport.close();
    await close(upstream);
  }
});

test('upstream transport rejects oversized responses without retaining the body', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('response larger than the configured test limit');
  });
  const port = await listen(upstream);
  const transport = createUpstreamHttpTransport({ maxResponseBytes: 8 });

  try {
    const result = await transport.sendBuffered(
      Buffer.alloc(0),
      'POST',
      '/v1/chat/completions',
      {},
      { proto: 'http', host: '127.0.0.1', port, vendor: 'test' },
      { firstByteTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
    );

    assert.equal(result.status, 0);
    assert.equal(result.networkError?.code, 'ERESPONSETOOLARGE');
    assert.equal(result.failureOrigin, 'internal');
    assert.equal(result.body.length, 0);
  } finally {
    transport.close();
    await close(upstream);
  }
});

test('proxy fallback shares one total deadline with the direct attempt', async () => {
  const upstream = http.createServer((_req, res) => {
    setTimeout(() => res.end('eventually'), 80);
  });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer();
  proxy.on('connect', (_req, socket) => {
    setTimeout(() => socket.destroy(), 80);
  });
  const proxyPort = await listen(proxy);
  const transport = createUpstreamHttpTransport({
    sharedProxyUrl: `http://127.0.0.1:${proxyPort}`,
    sharedProxyVendor: 'shared-only',
    logger: { log() {} },
  });

  try {
    const started = Date.now();
    const result = await transport.sendBuffered(
      Buffer.alloc(0),
      'GET',
      '/',
      {},
      {
        proto: 'http', host: '127.0.0.1', port: upstreamPort,
        vendor: 'fallback-test', useProxy: true,
      },
      { firstByteTimeoutMs: 500, totalTimeoutMs: 120 },
    );

    assert.equal(result.status, 0);
    assert.equal(result.networkError?.code, 'ETIMEDOUT');
    assert.match(result.networkError?.message || '', /total timeout/);
    assert.ok(Date.now() - started < 155, 'fallback must not restart the total timer');
  } finally {
    transport.close();
    await close(proxy);
    await close(upstream);
  }
});
