import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCursorAcpPrompt,
  createCursorAcpBridge,
  extractAcpText,
  runCursorAcpPrompt,
  toOpenAiResponse,
  toOpenAiSse,
  validateChatRequest,
} from '../src/providers/adapters/cursor-acp-bridge.mjs';

assert.equal(
  buildCursorAcpPrompt([
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
  ]),
  '[system]\nYou are concise.\n\n[user]\nSay hello.',
);

assert.equal(validateChatRequest({ model: 'cursor-agent', messages: [] }), 'request requires a non-empty messages[]');
assert.equal(validateChatRequest({ model: 'cursor-agent', messages: [{ role: 'user', content: 'hi' }] }), '');
assert.match(
  validateChatRequest({ model: 'cursor-agent', messages: [{ role: 'user', content: ' ' }] }),
  /must not be empty/,
);
assert.equal(
  extractAcpText({
    method: 'session/update',
    params: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    },
  }),
  'hello',
);
assert.equal(toOpenAiResponse('hello', 'cursor-agent').choices[0].message.content, 'hello');
const sse = toOpenAiSse('hello', 'cursor-agent');
assert.match(sse, /"object":"chat\.completion\.chunk"/);
assert.match(sse, /"content":"hello"/);
assert.match(sse, /data: \[DONE\]\n\n$/);
assert.throws(
  () => createCursorAcpBridge({ enabled: true, host: '0.0.0.0' }),
  /loopback address/,
);

const fakeAcp = [
  "const rl=require('node:readline').createInterface({input:process.stdin});",
  "rl.on('line',line=>{const m=JSON.parse(line);",
  "if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}));",
  "else if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'test-session'}}));",
  "else if(m.method==='session/prompt'){console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP works'}}}}));",
  "console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));}});",
].join('');

const result = await runCursorAcpPrompt({
  command: process.execPath,
  args: ['-e', fakeAcp],
  apiKey: 'test-key',
  cwd: process.cwd(),
  prompt: '[user]\nhello',
  timeoutMs: 5_000,
});
assert.equal(result.text, 'ACP works');

// Capacity is reserved before a slow request body finishes uploading.
const bridgePort = await freePort();
const bridge = createCursorAcpBridge({
  enabled: true,
  host: '127.0.0.1',
  port: bridgePort,
  command: process.execPath,
  args: ['-e', fakeAcp],
  apiKey: 'test-key',
  maxConcurrent: 1,
});
await bridge.listen();
const streamed = await postText(bridgePort, {
  model: 'cursor-agent',
  stream: true,
  messages: [{ role: 'user', content: 'stream this' }],
});
assert.equal(streamed.status, 200);
assert.match(streamed.contentType, /^text\/event-stream/);
assert.match(streamed.body, /"content":"ACP works"/);
assert.match(streamed.body, /data: \[DONE\]\n\n$/);
const slowSocket = net.connect(bridgePort, '127.0.0.1');
await new Promise((resolve, reject) => {
  slowSocket.once('connect', resolve);
  slowSocket.once('error', reject);
});
const slowBody = JSON.stringify({
  model: 'cursor-agent', messages: [{ role: 'user', content: 'slow' }],
});
slowSocket.write(
  `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
  `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(slowBody)}\r\n\r\n` +
  slowBody.slice(0, 1),
);
await waitUntil(() => bridge.snapshot().active === 1);
const busy = await postJson(bridgePort, {
  model: 'cursor-agent', messages: [{ role: 'user', content: 'second' }],
});
assert.equal(busy.status, 503);
assert.equal(busy.body.error.type, 'cursor_acp_busy');
slowSocket.destroy();
await waitUntil(() => bridge.snapshot().active === 0);
await bridge.close();

// Promise settlement must not suppress SIGKILL escalation for a child that
// deliberately ignores SIGTERM.
const directory = mkdtempSync(join(tmpdir(), 'cursor-acp-child-'));
const pidPath = join(directory, 'pid');
const previousPidPath = process.env.CURSOR_ACP_TEST_PID_PATH;
process.env.CURSOR_ACP_TEST_PID_PATH = pidPath;
const stubbornChild = [
  "require('node:fs').writeFileSync(process.env.CURSOR_ACP_TEST_PID_PATH,String(process.pid));",
  "process.on('SIGTERM',()=>{});",
  'setInterval(()=>{},1000);',
].join('');
try {
  await assert.rejects(
    runCursorAcpPrompt({
      command: process.execPath,
      args: ['-e', stubbornChild],
      apiKey: 'test-key',
      prompt: '[user]\ntime out',
      timeoutMs: 1_000,
    }),
    /timed out/,
  );
  await waitUntil(() => {
    try { return Boolean(readFileSync(pidPath, 'utf8').trim()); } catch { return false; }
  });
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
} finally {
  if (previousPidPath === undefined) delete process.env.CURSOR_ACP_TEST_PID_PATH;
  else process.env.CURSOR_ACP_TEST_PID_PATH = previousPidPath;
  rmSync(directory, { recursive: true, force: true });
}

console.log('test_cursor_acp_bridge: ok');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function postJson(port, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function postText(port, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        contentType: String(response.headers['content-type'] || ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for test condition');
}

