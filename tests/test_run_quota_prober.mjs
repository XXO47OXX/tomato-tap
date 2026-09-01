import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'mimo-supervisor-'));
const childScript = join(temp, 'child.mjs');
const port = 20_000 + (process.pid % 20_000);
writeFileSync(childScript, `
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);

const env = {
  ...process.env,
  PORT: String(port),
  NODE_BIN: process.execPath,
  PROXY_SCRIPT: childScript,
  QUOTA_PROBER_SCRIPT: childScript,
  TOMATO_TAP_PID_DIR: temp,
  TOMATO_TAP_LOG_FILE: join(temp, 'supervisor.log'),
  DRAIN_TIMEOUT_S: '2',
};

try {
  const started = await run('start');
  assert.match(started.stdout, /proxy PID \d+/);
  assert.match(started.stdout, /quota-prober PID \d+/);

  const idempotent = await run('start');
  assert.match(idempotent.stdout, /already running/);

  const status = await run('status');
  assert.match(status.stdout, /supervisor PID \d+/);
  assert.match(status.stdout, /proxy PID \d+/);
  assert.match(status.stdout, /quota-prober PID \d+/);

  const proxyPid = Number(readFileSync(join(temp, `tomato-tap.${port}.pid`), 'utf8'));
  const proberPid = Number(readFileSync(
    join(temp, `tomato-tap.${port}.quota-prober.pid`),
    'utf8',
  ));
  assert.notEqual(proxyPid, proberPid);
  process.kill(proxyPid, 'SIGTERM');
  await waitFor(() => {
    const next = Number(readFileSync(join(temp, `tomato-tap.${port}.pid`), 'utf8'));
    return next !== proxyPid;
  }, 4000);
  assert.equal(Number(readFileSync(
    join(temp, `tomato-tap.${port}.quota-prober.pid`),
    'utf8',
  )), proberPid);

  const restartedProxyPid = Number(readFileSync(
    join(temp, `tomato-tap.${port}.pid`),
    'utf8',
  ));
  process.kill(proberPid, 'SIGTERM');
  await waitFor(() => {
    const next = Number(readFileSync(
      join(temp, `tomato-tap.${port}.quota-prober.pid`),
      'utf8',
    ));
    return next !== proberPid;
  }, 4000);
  assert.equal(Number(readFileSync(
    join(temp, `tomato-tap.${port}.pid`),
    'utf8',
  )), restartedProxyPid);

  const stopped = await run('stop');
  assert.match(stopped.stdout, /stopped/);
  const finalStatus = await runAllowFailure('status');
  assert.match(finalStatus.stdout, /not running/);
} finally {
  await runAllowFailure('stop');
  rmSync(temp, { recursive: true, force: true });
}

console.log('test_run_quota_prober: ok');

function run(action) {
  return execFileAsync('bash', ['scripts/run.sh', action], { cwd: root, env });
}

async function runAllowFailure(action) {
  try {
    return await run(action);
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for supervisor restart');
}
