#!/usr/bin/env node
/**
 * 代理节点健康验证：从订阅拉取全部节点，逐个启动 sing-box 实测
 * reality 握手 + 外网连通，输出可用/不可用清单。
 *
 * 用法：
 *   node scripts/proxy_nodes_check.mjs                # 用 .env 里的订阅 URL
 *   node scripts/proxy_nodes_check.mjs <订阅URL>       # 显式指定订阅
 *   node scripts/proxy_nodes_check.mjs --bind <slug>  # 把可用节点写入 proxy-bindings
 *
 * 结果：
 *   - 控制台输出每个节点的 ✅/❌
 *   - --write 时把存活节点 id 列表写到 runtime/proxy-nodes-health.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { applyLegacyEnvAliases } from '../../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env);
process.umask(0o077);
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT_DIR = path.join(ROOT, 'runtime', 'proxy-check');
const SBOX_BIN = process.env.TOMATO_TAP_SING_BOX_BIN || 'sing-box';
const TEST_URL = process.env.PROXY_CHECK_TEST_URL || 'https://api.ipify.org';
const PER_NODE_TIMEOUT_MS = 10_000;
const STARTUP_MS = 2_500;
const BASE_PORT = 12100; // 避开 tomato-tap 11001-11999 正式范围

// ---- 订阅拉取 ----
async function loadSubscription(url) {
  const { parseProxySubscription } = await import(path.join(ROOT, 'src', 'egress', 'proxy-subscription.mjs'));
  const text = await fetchText(url);
  return parseProxySubscription(text);
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// ---- sing-box 单节点验证 ----
function testNode(node, port) {
  return new Promise((resolve) => {
    fs.mkdirSync(SCRIPT_DIR, { recursive: true });
    const cfg = {
      log: { level: 'error' },
      inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port }],
      outbounds: [{
        type: 'vless', tag: 'proxy',
        server: node.server, server_port: node.port, uuid: node.uuid,
        ...(node.params?.flow === 'xtls-rprx-vision' ? { flow: 'xtls-rprx-vision' } : {}),
        ...(node.tls?.security && node.tls.security !== 'none' ? {
          tls: {
            enabled: true,
            server_name: node.tls.serverName || node.server,
            ...(node.tls.security === 'reality' ? {
              reality: { enabled: true, public_key: node.params?.pbk || '', short_id: node.params?.sid || '' },
            } : {}),
            ...(node.params?.fp ? { utls: { enabled: true, fingerprint: node.params.fp } } : {}),
          },
        } : {}),
      }],
      route: { final: 'proxy' },
    };
    const cfgPath = path.join(SCRIPT_DIR, `${node.id}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });

    const child = spawn(SBOX_BIN, ['run', '-c', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', () => { /* drain */ });
    const startedAt = Date.now();
    const timer = setTimeout(() => finish('startup_timeout'), STARTUP_MS + PER_NODE_TIMEOUT_MS);

    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve(status);
    };
    child.on('error', () => finish('binary_error'));
    child.on('exit', () => finish('singbox_exit'));

    // 等监听就绪后实测外网（HTTP CONNECT 隧道 → TLS）
    const target = new URL(TEST_URL);
    const probe = setInterval(() => {
      try {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.destroy();
          clearInterval(probe);
          const connectReq = http.request({
            host: '127.0.0.1', port, method: 'CONNECT', path: `${target.host}:443`, timeout: PER_NODE_TIMEOUT_MS,
          });
          connectReq.on('connect', (res, tunnel) => {
            if (res.statusCode !== 200) {
              finish(`connect_${res.statusCode}`);
              tunnel.destroy();
              return;
            }
            const tlsSock = tls.connect({ socket: tunnel, servername: target.host }, () => {
              tlsSock.write(`GET ${target.pathname || '/'} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
            });
            let gotResponse = false;
            tlsSock.on('data', (d) => {
              const head = d.toString().split('\r\n')[0] || '';
              if (/^HTTP\/\d\.\d 200/.test(head)) { gotResponse = true; finish('ok'); tlsSock.destroy(); }
            });
            tlsSock.on('error', () => finish('tls_fail'));
            tlsSock.on('end', () => { if (!gotResponse) finish('tls_empty'); });
          });
          connectReq.on('error', () => finish('connect_fail'));
          connectReq.end();
        });
        sock.on('error', () => { /* not ready yet */ });
      } catch { /* ignore */ }
    }, 300);
    // 超时保护
    setTimeout(() => { clearInterval(probe); finish('not_ready'); }, STARTUP_MS + PER_NODE_TIMEOUT_MS);
  });
}

// ---- 主流程 ----
async function main() {
  const args = process.argv.slice(2);
  const writeHealth = args.includes('--write');
  const urlArg = args.find((a) => !a.startsWith('--'));
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const subUrl = urlArg || env.TOMATO_TAP_PROXY_SUBSCRIPTION_URL;
  if (!subUrl) { console.error('no subscription URL'); process.exit(1); }

  console.log(`拉取订阅: ${subUrl.slice(0, 60)}...`);
  const nodes = await loadSubscription(subUrl);
  console.log(`共 ${nodes.length} 个节点，逐个验证（每节点 ≤${PER_NODE_TIMEOUT_MS / 1000}s）...\n`);

  const results = [];
  // 串行测试：每次一个节点、独立端口，避免并发 sing-box 进程互相干扰
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const port = BASE_PORT + i;
    const status = await testNode(node, port);
    results.push({ node, status });
    const mark = status === 'ok' ? '✅' : '❌';
    console.log(`${mark} ${node.server}:${node.port} ${status}`);
  }

  const alive = results.filter((r) => r.status === 'ok').map((r) => r.node.id);
  const dead = results.filter((r) => r.status !== 'ok').map((r) => r.node.id);
  console.log(`\n存活 ${alive.length}/${nodes.length}，死亡 ${dead.length}`);

  if (writeHealth) {
    const out = {
      checkedAt: new Date().toISOString(),
      subscriptionUrl: subUrl,
      total: nodes.length,
      aliveIds: alive,
      deadIds: dead,
      nodes: results.map(({ node, status }) => ({
        id: node.id,
        server: node.server,
        port: node.port,
        uuid: node.uuid,
        transport: node.transport,
        tls: node.tls,
        params: node.params,
        status,
      })),
    };
    fs.writeFileSync(path.join(ROOT, 'runtime', 'proxy-nodes-health.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
    console.log(`健康清单已写入 runtime/proxy-nodes-health.json`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
