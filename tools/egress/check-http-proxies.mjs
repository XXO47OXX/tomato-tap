#!/usr/bin/env node
/**
 * Validate an operator-supplied HTTP proxy list using CONNECT requests.
 *
 * 用法：
 *   node tools/egress/check-http-proxies.mjs <file> [file...]
 *   node tools/egress/check-http-proxies.mjs --write <file>
 *
 * 结果：
 *   - 控制台输出进度与汇总
 *   - --write 时把全部节点（含 status）写到 runtime/proxy-http-health.json，
 *     proxy_pool_start.mjs 读取 status==='ok' 的 http 节点与订阅节点合并启动。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { applyLegacyEnvAliases } from '../../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env);
process.umask(0o077);

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FILE = process.env.TOMATO_TAP_HTTP_PROXY_FILE || '';
const TEST_TARGET = process.env.HTTP_PROXY_TEST_TARGET || 'api.ipify.org';
const PER_PROXY_TIMEOUT_MS = 8_000;
const CONCURRENCY = 20; // 并发过高会被代理商限流（实测 100 并发触发 429/断连）

function parseLine(raw) {
  const line = raw.trim().replace(/\r$/, '');
  if (!line || line.startsWith('#')) return null;
  // 支持 http://user:pass@host:port / user:pass@host:port / http://host:port
  const body = line.replace(/^https?:\/\//, '');
  const at = body.lastIndexOf('@');
  const hostport = at >= 0 ? body.slice(at + 1) : body;
  const auth = at >= 0 ? body.slice(0, at) : '';
  const m = hostport.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const [username, password] = auth ? auth.split(':', 2) : ['', ''];
  return { server: m[1], port: parseInt(m[2], 10), username, password };
}

// 直连远端代理实测：CONNECT（带认证）→ TLS → GET → 期望 200
function testHttpProxy(proxy) {
  return new Promise((resolve) => {
    // 关键：Host 必须指向目标（host:port）。node 默认 Host 是代理地址本身，
    // 按 Host 路由的代理会回退到自身页面，隧道里收到明文 → TLS 报
    // ERR_SSL_PACKET_LENGTH_TOO_LONG。curl 风格头实测可用。
    const headers = {
      Host: `${TEST_TARGET}:443`,
      'Proxy-Connection': 'Keep-Alive',
      'User-Agent': 'curl/8.0',
    };
    if (proxy.username) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
    }
    const settled = (status) => {
      if (done) return;
      done = true;
      resolve(status);
    };
    let done = false;
    const req = http.request({
      host: proxy.server, port: proxy.port,
      method: 'CONNECT', path: `${TEST_TARGET}:443`, headers, timeout: PER_PROXY_TIMEOUT_MS,
    });
    req.on('connect', (res, tunnel) => {
      if (res.statusCode !== 200) { settled(`connect_${res.statusCode}`); tunnel.destroy(); return; }
      const tlsSock = tls.connect({ socket: tunnel, servername: TEST_TARGET }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${TEST_TARGET}\r\nConnection: close\r\n\r\n`);
      });
      let ok = false;
      tlsSock.on('data', (d) => {
        if (/^HTTP\/\d\.\d 200/.test(d.toString().split('\r\n')[0] || '')) { ok = true; settled('ok'); tlsSock.destroy(); }
      });
      tlsSock.on('error', () => settled('tls_fail'));
      tlsSock.on('end', () => settled(ok ? 'ok' : 'tls_empty'));
    });
    req.on('timeout', () => { settled('timeout'); req.destroy(); });
    req.on('error', () => settled('connect_fail'));
    req.end();
  });
}

function dedupe(proxies) {
  const seen = new Set();
  const out = [];
  for (const p of proxies) {
    const key = `${p.server}:${p.port}:${p.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function nodeId(p) {
  return createHash('sha1').update(`http:${p.server}:${p.port}:${p.username}`).digest('hex').slice(0, 16);
}

async function runAll(proxies) {
  const results = new Array(proxies.length);
  const reasons = {};
  let cursor = 0;
  let aliveCount = 0;
  const worker = async () => {
    while (cursor < proxies.length) {
      const i = cursor++;
      const status = await testHttpProxy(proxies[i]);
      results[i] = status;
      if (status === 'ok') {
        aliveCount++;
      } else {
        reasons[status] = (reasons[status] || 0) + 1;
      }
      if (cursor % 200 === 0 || cursor === proxies.length) {
        console.log(`进度 ${cursor}/${proxies.length}，存活 ${aliveCount}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, proxies.length) }, worker));
  return { results, reasons, aliveCount };
}

async function main() {
  const args = process.argv.slice(2);
  const writeHealth = args.includes('--write');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1], 10) : 0;
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit 必须是正整数');
    process.exit(1);
  }
  const consumed = new Set(limitIndex >= 0 ? [limitIndex, limitIndex + 1] : []);
  const files = args.filter((a, i) => !consumed.has(i) && !a.startsWith('--'));
  const sources = files.length ? files : [DEFAULT_FILE];

  let proxies = [];
  for (const f of sources) {
    if (!fs.existsSync(f)) { console.error(`文件不存在: ${f}`); process.exit(1); }
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const parsed = lines.map(parseLine).filter(Boolean);
    console.log(`${f}: ${parsed.length} 条`);
    proxies.push(...parsed);
  }
  proxies = dedupe(proxies);
  if (limit > 0 && proxies.length > limit) proxies = proxies.slice(0, limit);
  console.log(`去重后共 ${proxies.length} 条，并发 ${CONCURRENCY} 实测...\n`);

  const { results, reasons, aliveCount } = await runAll(proxies);
  console.log(`\n存活 ${aliveCount}/${proxies.length}`);
  if (Object.keys(reasons).length) {
    console.log(`失败原因: ${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }

  if (writeHealth) {
    const nodes = proxies.map((p, i) => ({
      id: nodeId(p),
      type: 'http',
      server: p.server,
      port: p.port,
      username: p.username,
      password: p.password,
      status: results[i],
    }));
    const out = {
      checkedAt: new Date().toISOString(),
      source: sources,
      total: nodes.length,
      aliveIds: nodes.filter((n) => n.status === 'ok').map((n) => n.id),
      deadIds: nodes.filter((n) => n.status !== 'ok').map((n) => n.id),
      nodes,
    };
    fs.writeFileSync(path.join(ROOT, 'runtime', 'proxy-http-health.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
    console.log(`健康清单已写入 runtime/proxy-http-health.json`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
