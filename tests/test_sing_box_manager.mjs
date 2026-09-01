import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSingBoxManager } from '../src/egress/sing-box-manager.mjs';

const runtimeDir = mkdtempSync(join(tmpdir(), 'mimo-sing-box-'));
const spawns = [];
const timers = [];
const readiness = [];
function spawnImpl(binary, args, options) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  spawns.push({ binary, args, options, child });
  return child;
}

try {
  const manager = createSingBoxManager({
    binary: '/usr/local/bin/sing-box', runtimeDir, spawnImpl,
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
    probeImpl: (port, done) => { readiness.push({ port, done }); },
  });
  const node = {
    id: '0123456789abcdef', protocol: 'vless', server: 'edge.example', port: 443,
    uuid: '11111111-1111-4111-8111-111111111111', transport: 'ws',
    tls: { security: 'tls', serverName: 'sni.example' },
    params: { path: '/edge', host: 'host.example', flow: 'none' },
  };
  const first = manager.ensure(node, 11001);
  assert.equal(first.proxyUrl, 'http://127.0.0.1:11001');
  assert.equal(first.state, 'starting');
  assert.equal(readiness[0].port, 11001);
  assert.equal(spawns[0].child.stderr.listenerCount('data'), 1, 'stderr must be drained');
  readiness.shift().done(true);
  assert.equal(manager.status(node.id).state, 'running');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(0, 2), ['run', '-c']);
  const configPath = spawns[0].args[2];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.inbounds[0].type, 'mixed');
  assert.equal(config.inbounds[0].listen_port, 11001);
  assert.equal(config.outbounds[0].type, 'vless');
  assert.equal(config.outbounds[0].transport.type, 'ws');
  assert.equal(config.outbounds[0].tls.server_name, 'sni.example');
  assert.equal(config.outbounds[0].flow, undefined, 'flow=none must be omitted');
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  const realityNode = {
    id: 'fedcba9876543210', protocol: 'vless', server: 'reality.example', port: 443,
    uuid: '22222222-2222-4222-8222-222222222222', transport: 'tcp',
    tls: { security: 'reality', serverName: 'cover.example' },
    params: {
      flow: 'xtls-rprx-vision', pbk: 'public-key', sid: '0123456789abcdef', fp: 'chrome',
    },
  };
  manager.ensure(realityNode, 11002);
  readiness.shift().done(true);
  const realityConfig = JSON.parse(readFileSync(spawns[1].args[2], 'utf8'));
  assert.equal(realityConfig.outbounds[0].flow, 'xtls-rprx-vision');
  assert.deepEqual(realityConfig.outbounds[0].tls.reality, {
    enabled: true, public_key: 'public-key', short_id: '0123456789abcdef',
  });
  assert.deepEqual(realityConfig.outbounds[0].tls.utls, {
    enabled: true, fingerprint: 'chrome',
  });

  manager.ensure(node, 11001);
  assert.equal(spawns.length, 2, 'same node listener is reused');

  spawns[0].child.emit('exit', 1, null);
  assert.equal(timers.length, 1, 'failed child schedules same-node restart');
  timers.shift()();
  assert.equal(spawns.length, 3);
  assert.equal(spawns[2].args[2], configPath);

  const statusText = JSON.stringify(manager.status(node.id));
  assert(!statusText.includes(node.uuid));
  assert(!statusText.includes(node.server));
  assert(statusText.includes(node.id));

  const stopPromise = manager.stopAll();
  assert(stopPromise instanceof Promise, 'stopAll must wait for child termination');
  assert.equal(spawns[2].child.killed, true);
  spawns[1].child.emit('close', 0, 'SIGTERM');
  spawns[2].child.emit('close', 0, 'SIGTERM');
  await stopPromise;

  const errorSpawns = [];
  const errorTimers = [];
  const errorManager = createSingBoxManager({
    runtimeDir: join(runtimeDir, 'spawn-error'),
    spawnImpl(_binary, _args, _options) {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      errorSpawns.push(child);
      return child;
    },
    probeImpl: () => {},
    setTimeoutImpl: (fn) => { errorTimers.push(fn); return errorTimers.length; },
  });
  errorManager.ensure(node, 11003);
  const spawnError = Object.assign(new Error('missing'), { code: 'ENOENT' });
  errorSpawns[0].emit('error', spawnError);
  errorSpawns[0].emit('close', 1, null);
  assert.equal(errorManager.status(node.id).lastError, 'binary_not_found');
  assert.equal(errorTimers.length, 1, 'error plus close schedules one restart');
  errorTimers.shift()();
  assert.equal(errorSpawns.length, 2, 'spawn error restarts the same node');
  const errorStop = errorManager.stopAll();
  errorSpawns[1].emit('close', 0, 'SIGTERM');
  await errorStop;

  const killSignals = [];
  const stopTimers = [];
  let stubbornChild;
  const stubbornManager = createSingBoxManager({
    runtimeDir: join(runtimeDir, 'stubborn'),
    spawnImpl() {
      stubbornChild = new EventEmitter();
      stubbornChild.stderr = new EventEmitter();
      stubbornChild.kill = (signal) => { killSignals.push(signal); };
      return stubbornChild;
    },
    probeImpl: (_port, done) => done(true),
    setTimeoutImpl: (fn) => { stopTimers.push(fn); return stopTimers.length; },
  });
  stubbornManager.ensure(node, 11004);
  const stubbornStop = stubbornManager.stopAll({ graceMs: 1 });
  assert.deepEqual(killSignals, ['SIGTERM']);
  stopTimers.shift()();
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  stopTimers.shift()();
  await stubbornStop;
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}

console.log('test_sing_box_manager: ok');
