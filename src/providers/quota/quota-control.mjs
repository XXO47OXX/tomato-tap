import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';

const MAX_LINE_BYTES = 16 * 1024;

export function createQuotaControlServer({
  socketPath,
  manager,
  onStateChanged = () => {},
}) {
  let server;

  async function listen() {
    const directory = dirname(socketPath);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted) chmodSync(directory, 0o700);
    if (existsSync(socketPath)) {
      if (await socketAcceptsConnections(socketPath)) {
        throw new Error(`quota-control: socket already in use: ${socketPath}`);
      }
      unlinkSync(socketPath);
    }
    server = createServer((socket) => handleConnection(socket, manager, onStateChanged));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
  }

  async function close() {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // A replaced path belongs to the operator; do not make shutdown fatal.
      }
    }
  }

  return { listen, close };
}

export function createQuotaControlClient({ socketPath, timeoutMs = 5_000 }) {
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = '';
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(
          () => finish(new Error('quota-control: request timed out')),
          timeoutMs,
        );
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
            finish(new Error('quota-control: response too large'));
            return;
          }
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          try {
            finish(null, JSON.parse(buffer.slice(0, newline)));
          } catch {
            finish(new Error('quota-control: malformed response'));
          }
        });
        socket.on('error', (error) => finish(error));
        socket.on('end', () => {
          if (!settled) finish(new Error('quota-control: connection closed without response'));
        });
      });
    },
  };
}

function handleConnection(socket, manager, onStateChanged) {
  let buffer = '';
  let answered = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (answered) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      answered = true;
      send(socket, { id: null, ok: false, error: 'request too large' });
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    answered = true;
    let message;
    try {
      message = JSON.parse(buffer.slice(0, newline));
    } catch {
      send(socket, { id: null, ok: false, error: 'malformed JSON' });
      return;
    }
    Promise.resolve()
      .then(() => dispatch(message, manager, onStateChanged))
      .then((response) => send(socket, response))
      .catch((error) => send(socket, {
        id: message?.id ?? null,
        ok: false,
        error: String(error?.message || 'request failed').slice(0, 256),
      }));
  });
}

function dispatch(message, manager, onStateChanged) {
  const id = message?.id ?? null;
  if (message?.method === 'claim_due') {
    const now = finiteNumber(message.now, Date.now());
    const limit = Math.max(1, Math.min(32, Math.floor(finiteNumber(message.limit, 1))));
    const claimed = manager.claimDueProbes(now, limit);
    if (claimed.length > 0) {
      onStateChanged(manager.snapshot(), { method: 'claim_due', claims: claimed });
    }
    return { id, ok: true, claims: claimed };
  }
  if (message?.method === 'report_probe') {
    const accepted = manager.recordProbeResult({
      deploymentId: String(message.deploymentId || ''),
      claimToken: String(message.claimToken || ''),
      valid: message.valid === true,
      status: finiteNumber(message.status, 0),
      quotaSignal: sanitizeQuotaSignal(message.quotaSignal),
      observedAt: finiteNumber(message.observedAt, Date.now()),
    });
    onStateChanged(manager.snapshot(), {
      method: 'report_probe',
      deploymentId: String(message.deploymentId || ''),
      accepted,
      valid: message.valid === true,
    });
    return { id, ok: true, accepted };
  }
  return { id, ok: false, error: `unknown method "${String(message?.method || '')}"` };
}

function send(socket, response) {
  socket.end(`${JSON.stringify(response)}\n`);
}

function sanitizeQuotaSignal(value) {
  if (!value || value.matched !== true) return null;
  const retryAfterMs = Number(value.retryAfterMs);
  return {
    matched: true,
    label: String(value.label || 'quota_exhausted').slice(0, 128),
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null,
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
