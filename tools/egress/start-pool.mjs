#!/usr/bin/env node
/**
 * Start one local sing-box listener per healthy egress node.
 *
 * 用法：
 *   node tools/egress/start-pool.mjs
 *   node tools/egress/start-pool.mjs --status
 *   node tools/egress/start-pool.mjs --stop
 *   node tools/egress/start-pool.mjs --limit 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { applyLegacyEnvAliases } from '../../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env);
process.umask(0o077);

const ROOT = path.resolve(import.meta.dirname, '../..');
const HEALTH_FILE = path.join(ROOT, 'runtime', 'proxy-nodes-health.json');
const HTTP_HEALTH_FILE = path.join(ROOT, 'runtime', 'proxy-http-health.json');
const POOL_DIR = path.join(ROOT, 'runtime', 'proxy-pool');
const SBOX_BIN = process.env.TOMATO_TAP_SING_BOX_BIN || 'sing-box';
const BASE_PORT = 11100; // tomato-tap sticky 用 11001-11099，池从 11100 起
const STATE_FILE = path.join(ROOT, 'runtime', 'proxy-pool-state.json');
const HTTP_LIMIT = parseInt(process.env.TOMATO_TAP_HTTP_POOL_LIMIT || '10', 10); // http 节点入池上限

const state = {};

function loadHealth() {
  if (!fs.existsSync(HEALTH_FILE)) {
    console.error('Health inventory missing; run: node tools/egress/check-nodes.mjs --write');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
}

// http 列表清单缺失时只警告不退出：订阅节点仍是主来源，http 是补充
function loadHttpHealth() {
  if (!fs.existsSync(HTTP_HEALTH_FILE)) {
    console.log('HTTP proxy inventory missing; skipping optional HTTP nodes.');
    return { nodes: [] };
  }
  return JSON.parse(fs.readFileSync(HTTP_HEALTH_FILE, 'utf8'));
}

// WSL 重启后 state 里的旧 PID 已失效（kill 抛 ESRCH），甚至可能被新进程复用。
// 所有"已在运行"判断必须同时过 PID 存活 + 端口实测，不能只信 state。
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function buildConfig(node, localPort) {
  let outbound;
  if (node.type === 'http') {
    outbound = { type: 'http', tag: 'proxy', server: node.server, server_port: node.port };
    if (node.username) { outbound.username = node.username; outbound.password = node.password || ''; }
  } else {
    outbound = { type: 'vless', tag: 'proxy', server: node.server, server_port: node.port, uuid: node.uuid };
    if (node.params?.flow === 'xtls-rprx-vision') outbound.flow = node.params.flow;
    if (node.tls?.security && node.tls.security !== 'none') {
      outbound.tls = { enabled: true, server_name: node.tls.serverName || node.server };
      if (node.tls.security === 'reality') {
        outbound.tls.reality = { enabled: true, public_key: node.params?.pbk || '', short_id: node.params?.sid || '' };
        if (node.params?.fp) outbound.tls.utls = { enabled: true, fingerprint: node.params.fp };
      }
    }
  }
  return {
    log: { level: 'warn', output: 'stderr', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: localPort }],
    outbounds: [outbound],
    route: { final: 'proxy' },
  };
}

async function testProxy(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const target = 'api.ipify.org';
    const http = import('node:http');
    http.then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${target}:443`, timeout: timeoutMs });
      req.on('connect', (res, tunnel) => {
        if (res.statusCode !== 200) { tunnel.destroy(); resolve(false); return; }
        const tls = import('node:tls');
        tls.then(({ connect }) => {
          const tlsSock = connect({ socket: tunnel, servername: target }, () => {
            tlsSock.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
          });
          let ok = false;
          tlsSock.on('data', (d) => {
            if (/^HTTP\/\d\.\d 200/.test(d.toString().split('\r\n')[0] || '')) { ok = true; resolve(true); tlsSock.destroy(); }
          });
          tlsSock.on('error', () => { if (!ok) resolve(false); });
          tlsSock.on('end', () => { if (!ok) resolve(false); });
        });
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  });
}

async function startNode(node, port) {
  fs.mkdirSync(POOL_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(POOL_DIR, 0o700); } catch { /* best effort */ }
  const cfgPath = path.join(POOL_DIR, `${node.id}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(buildConfig(node, port), null, 2), { mode: 0o600 });
  const child = spawn(SBOX_BIN, ['run', '-c', cfgPath], { stdio: 'ignore', detached: true });
  child.unref();
  state[node.id] = { port, pid: child.pid, server: node.server, upstreamPort: node.port };
  // 等 2.5s 后验证
  await new Promise((r) => setTimeout(r, 2500));
  const ok = await testProxy(port);
  if (!ok) {
    console.log(`❌ ${node.server}:${node.port} → 端口 ${port} 验证失败`);
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
    // 保留端口记录（pid=0 表示死亡），下次 watchdog 复用同一端口，
    // 避免 flaky 节点每次重试都分配新端口导致端口漂移
    state[node.id] = { port, pid: 0, server: node.server, upstreamPort: node.port };
    return false;
  }
  console.log(`✅ ${node.server}:${node.port} → 127.0.0.1:${port}`);
  return true;
}

// 清理孤儿 sing-box：进程在跑但不被 state 存活条目跟踪（崩溃遗留/重复实例），
// 会占住端口导致后续启动 bind 失败，必须先清。
async function sweepOrphans() {
  const { execSync } = await import('node:child_process');
  const keep = new Map();
  for (const [id, rec] of Object.entries(loadState())) {
    if (rec.pid > 0 && isAlive(rec.pid)) keep.set(id, rec.pid);
  }
  let lines = '';
  try {
    lines = execSync(`pgrep -af 'sing-box run -c .*proxy-pool'`, { encoding: 'utf8' });
  } catch { return; }
  for (const line of lines.split('\n')) {
    const m = line.match(/^(\d+)\s+.*proxy-pool\/([a-f0-9]+)\.json/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const id = m[2];
    if (keep.get(id) !== pid) {
      try { process.kill(pid, 'SIGTERM'); console.log(`🧹 清理孤儿 sing-box ${id} (pid=${pid})`); } catch { /* gone */ }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--stop')) {
    for (const rec of Object.values(loadState())) {
      // pid=0 是死亡标记，process.kill(0) 会误杀自身进程组
      if (rec.pid > 0) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      }
    }
    fs.rmSync(STATE_FILE, { force: true });
    fs.writeFileSync(path.join(ROOT, 'runtime', 'proxy-pool-ports'), '', { mode: 0o600 });
    await sweepOrphans(); // state 已清空，所有 pool sing-box 都是孤儿，一并清掉
    console.log('代理池已停止');
    return;
  }
  if (args.includes('--status')) {
    const st = loadState();
    const entries = Object.entries(st);
    if (entries.length === 0) { console.log('代理池未运行'); return; }
    for (const [id, rec] of entries) {
      const alive = rec.pid > 0 && isAlive(rec.pid);
      console.log(`${alive ? '✅' : '❌'} ${rec.server}:${rec.upstreamPort} → 127.0.0.1:${rec.port} pid=${rec.pid}`);
    }
    console.log(`\nTOMATO_TAP_PROXY_POOL="${entries.map(([, r]) => r.port).join(',')}"`);
    return;
  }

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const httpLimitIdx = args.indexOf('--http-limit');
  const httpLimit = httpLimitIdx >= 0 ? parseInt(args[httpLimitIdx + 1], 10) : HTTP_LIMIT;
  const health = loadHealth();
  const httpHealth = loadHttpHealth();
  // 订阅 vless 节点为主，http 列表节点为补充（上限 httpLimit，防止数千条撑爆资源）
  const vlessAlive = health.nodes.filter((n) => n.status === 'ok').slice(0, limit);
  const httpAlive = httpHealth.nodes.filter((n) => n.status === 'ok').slice(0, httpLimit);
  const alive = [...vlessAlive, ...httpAlive];
  const desiredIds = new Set(alive.map((node) => node.id));
  console.log(`启动 ${alive.length} 个代理节点（vless ${vlessAlive.length} + http ${httpAlive.length}）...`);

  await sweepOrphans();
  const prev = loadState();
  // 复活校验：PID 存活且端口实测通过才保留；WSL 重启后旧 PID 死亡/被复用，
  // 直接丢弃（端口随之释放，nextPort 不会被死条目抬高）
  for (const [id, rec] of Object.entries(prev)) {
    if (!desiredIds.has(id)) {
      if (rec.pid > 0 && isAlive(rec.pid)) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* gone */ }
      }
      console.log(`🧹 ${rec.server}:${rec.upstreamPort} 已超出当前代理池上限，停止实例`);
      continue;
    }
    if (rec.pid > 0 && isAlive(rec.pid) && (await testProxy(rec.port))) {
      state[id] = rec;
    } else {
      console.log(`♻️ ${rec.server}:${rec.upstreamPort} 实例已死，端口 ${rec.port} 释放复用`);
    }
  }
  const started = Object.values(state).map((r) => r.port);
  let nextPort = Math.max(BASE_PORT, ...started) + 1;
  for (const node of alive) {
    if (state[node.id]?.pid > 0) {
      console.log(`⏭️ ${node.server}:${node.port} 已在运行 (127.0.0.1:${state[node.id].port})`);
      continue;
    }
    // 端口粘性：同节点复用上次端口，flaky 节点反复重启不漂移
    const port = prev[node.id]?.port ?? nextPort++;
    const ok = await startNode(node, port);
    if (ok) started.push(port);
  }
  saveState();
  // Persist the active local ports for consumers that opt into this pool.
  fs.writeFileSync(path.join(ROOT, 'runtime', 'proxy-pool-ports'), started.join(','), { mode: 0o600 });
  console.log(`\n代理池就绪。设置: TOMATO_TAP_PROXY_POOL="${started.join(',')}"`);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

main().catch((e) => { console.error(e); process.exit(1); });
