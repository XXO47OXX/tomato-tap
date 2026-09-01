import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

export function createSingBoxManager({
  binary = 'sing-box',
  runtimeDir,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  probeImpl = probeLocalPort,
} = {}) {
  if (!runtimeDir) throw new Error('sing-box-manager: runtimeDir is required');
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const records = new Map();
  let stopping = false;
  let stopPromise = null;

  function ensure(node, localPort) {
    const existing = records.get(node.id);
    if (existing?.child) return publicRecord(existing);
    const configPath = join(runtimeDir, `${node.id}.json`);
    writeFileSync(configPath, `${JSON.stringify(buildConfig(node, localPort), null, 2)}\n`, { mode: 0o600 });
    chmodSync(configPath, 0o600);
    const record = existing || {
      nodeId: node.id, localPort, configPath, child: null, restartTimer: null,
      state: 'starting', lastError: '',
    };
    record.localPort = localPort;
    record.configPath = configPath;
    records.set(node.id, record);
    start(record);
    return publicRecord(record);
  }

  function start(record) {
    if (stopping) return;
    record.state = 'starting';
    record.lastError = '';
    let child;
    try {
      child = spawnImpl(binary, ['run', '-c', record.configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH },
      });
    } catch (error) {
      record.state = 'error';
      record.lastError = classifyError(error);
      scheduleRestart(record);
      return;
    }
    record.child = child;
    child.stderr?.on('data', () => { /* drain without logging proxy details */ });
    let finalized = false;
    const finalize = (reason) => {
      if (finalized) return;
      finalized = true;
      if (record.child === child) record.child = null;
      record.state = stopping ? 'stopped' : 'error';
      if (!stopping) {
        record.lastError = reason;
        scheduleRestart(record);
      }
    };
    waitUntilReady(record, child, finalize);
    child.once('error', (error) => finalize(classifyError(error)));
    child.once('exit', (code, signal) => {
      finalize(code === 0 ? 'unexpected_exit' : `exit_${code ?? signal ?? 'unknown'}`);
    });
    child.once('close', (code, signal) => {
      finalize(code === 0 ? 'unexpected_close' : `close_${code ?? signal ?? 'unknown'}`);
    });
  }

  function scheduleRestart(record) {
    if (stopping || record.restartTimer != null) return;
    record.restartTimer = setTimeoutImpl(() => {
      record.restartTimer = null;
      start(record);
    }, 1000);
  }

  function waitUntilReady(record, child, finalize, attempt = 0) {
    probeImpl(record.localPort, (ready) => {
      if (stopping || record.child !== child) return;
      if (ready) {
        record.state = 'running';
        record.lastError = '';
        return;
      }
      if (attempt >= 49) {
        finalize('listener_not_ready');
        try { child.kill('SIGTERM'); } catch { /* already stopped */ }
        return;
      }
      setTimeoutImpl(() => waitUntilReady(record, child, finalize, attempt + 1), 100);
    });
  }

  function status(nodeId) {
    const record = records.get(nodeId);
    return record ? publicRecord(record) : null;
  }

  function stopAll({ graceMs = 2_000 } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    const children = new Set();
    for (const record of records.values()) {
      if (record.restartTimer != null) {
        clearTimeoutImpl(record.restartTimer);
        record.restartTimer = null;
      }
      if (record.child) children.add(record.child);
      record.state = record.child ? 'stopping' : 'stopped';
    }
    stopPromise = Promise.all([...children].map((child) => stopChild(child, graceMs)))
      .then(() => {
        for (const record of records.values()) {
          record.child = null;
          record.state = 'stopped';
        }
      });
    return stopPromise;
  }

  function stopChild(child, graceMs) {
    return new Promise((resolve) => {
      let settled = false;
      let termTimer = null;
      let killTimer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (termTimer != null) clearTimeoutImpl(termTimer);
        if (killTimer != null) clearTimeoutImpl(killTimer);
        child.removeListener('exit', done);
        child.removeListener('close', done);
        resolve();
      };
      child.once('exit', done);
      child.once('close', done);
      termTimer = setTimeoutImpl(() => {
        try { child.kill('SIGKILL'); } catch { /* already stopped */ }
        killTimer = setTimeoutImpl(done, 250);
      }, graceMs);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  function publicRecord(record) {
    return {
      nodeId: record.nodeId,
      localPort: record.localPort,
      proxyUrl: `http://127.0.0.1:${record.localPort}`,
      state: record.state,
      lastError: record.lastError,
    };
  }

  return { ensure, status, stopAll };
}

function buildConfig(node, localPort) {
  const outbound = {
    type: 'vless',
    tag: 'proxy',
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
  };
  if (node.params?.flow === 'xtls-rprx-vision') outbound.flow = node.params.flow;
  if (node.tls?.security && node.tls.security !== 'none') {
    outbound.tls = {
      enabled: true,
      server_name: node.tls.serverName || node.server,
    };
    if (node.tls.security === 'reality') {
      outbound.tls.reality = {
        enabled: true,
        public_key: node.params?.pbk || '',
        short_id: node.params?.sid || '',
      };
      if (node.params?.fp) {
        outbound.tls.utls = { enabled: true, fingerprint: node.params.fp };
      }
    }
  }
  if (node.transport === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: node.params?.path || '/',
    };
    if (node.params?.host) outbound.transport.headers = { Host: node.params.host };
  } else if (node.transport === 'grpc') {
    outbound.transport = {
      type: 'grpc',
      service_name: node.params?.serviceName || node.params?.service_name || '',
    };
  }
  return {
    log: { level: 'warn', output: 'stderr', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: localPort }],
    outbounds: [outbound],
    route: { final: 'proxy' },
  };
}

function classifyError(error) {
  const code = String(error?.code || '').toLowerCase();
  if (code === 'enoent') return 'binary_not_found';
  if (code === 'eacces') return 'binary_not_executable';
  return 'process_error';
}

function probeLocalPort(port, done) {
  const socket = connect({ host: '127.0.0.1', port });
  let settled = false;
  const finish = (ready) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    done(ready);
  };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(250, () => finish(false));
}
