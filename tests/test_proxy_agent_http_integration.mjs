import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxyAgentPool } from '../src/egress/proxy-agent-pool.mjs';

const target = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('through-connect');
});
target.listen(0, '127.0.0.1');
await once(target, 'listening');

let connectCount = 0;
const proxy = http.createServer();
proxy.on('connect', (req, clientSocket, head) => {
  connectCount++;
  const [host, portText] = String(req.url || '').split(':');
  const upstream = net.connect({ host, port: Number(portText) }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.once('error', () => clientSocket.destroy());
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');

const targetPort = target.address().port;
const proxyPort = proxy.address().port;
const pool = createProxyAgentPool({ agentOptions: { keepAlive: false } });
const agent = pool.get(`http://127.0.0.1:${proxyPort}`, 'http:');

try {
  const body = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: targetPort, path: '/', agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(3_000, () => req.destroy(new Error('HTTP CONNECT test timed out')));
    req.once('error', reject);
  });
  assert.equal(body, 'through-connect');
  assert.equal(connectCount, 1, 'HTTP upstream must traverse the CONNECT proxy');
} finally {
  agent.destroy();
  proxy.close();
  target.close();
  await Promise.all([once(proxy, 'close'), once(target, 'close')]);
}

console.log('test_proxy_agent_http_integration: ok');
