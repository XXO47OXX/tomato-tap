import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import {
  createQuotaControlClient,
  createQuotaControlServer,
} from '../src/providers/quota/quota-control.mjs';

const directory = mkdtempSync(join(tmpdir(), 'mimo-quota-control-'));
const socketPath = join(directory, 'quota.sock');
let report;
let changes = 0;
const manager = {
  claimDueProbes(now, limit) {
    assert.equal(now, 1000);
    assert.equal(limit, 4);
    return [{
      deploymentId: 'quota-a',
      claimToken: 'claim-1',
      probeModel: 'model-a',
      probeMaxTokens: 128,
    }];
  },
  recordProbeResult(input) {
    report = input;
    return true;
  },
  snapshot() {
    return [{ deploymentId: 'quota-a', state: 'boosted' }];
  },
};

const server = createQuotaControlServer({
  socketPath,
  manager,
  onStateChanged(snapshot) {
    changes++;
    assert.equal(snapshot[0].state, 'boosted');
  },
});
await server.listen();

assert.equal(existsSync(socketPath), true);
assert.equal(statSync(socketPath).mode & 0o777, 0o600);

const client = createQuotaControlClient({ socketPath, timeoutMs: 1000 });
const claimResponse = await client.request({
  id: '1',
  method: 'claim_due',
  now: 1000,
  limit: 4,
});
assert.equal(claimResponse.ok, true);
assert.equal(claimResponse.claims[0].deploymentId, 'quota-a');
assert.equal(JSON.stringify(claimResponse).includes('apiKey'), false);
assert.equal(changes, 1);

const reportResponse = await client.request({
  id: '2',
  method: 'report_probe',
  deploymentId: 'quota-a',
  claimToken: 'claim-1',
  valid: true,
  status: 200,
  quotaSignal: null,
  observedAt: 1200,
});
assert.deepEqual(reportResponse, { id: '2', ok: true, accepted: true });
assert.equal(report.deploymentId, 'quota-a');
assert.equal(changes, 2);

async function rawLine(line) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(data.slice(0, newline)));
      }
    });
    socket.on('error', reject);
  });
}

assert.equal((await rawLine('{bad json')).ok, false);
assert.match((await rawLine(JSON.stringify({ id: '3', method: 'unknown' }))).error, /unknown method/i);
assert.match((await rawLine('x'.repeat(17 * 1024))).error, /too large/i);

await server.close();
assert.equal(existsSync(socketPath), false);

const stalePath = join(directory, 'stale.sock');
writeFileSync(stalePath, 'stale');
const staleServer = createQuotaControlServer({ socketPath: stalePath, manager });
await staleServer.listen();
assert.equal(existsSync(stalePath), true);
await staleServer.close();

const openDirectory = join(directory, 'open-runtime');
mkdirSync(openDirectory, { mode: 0o755 });
chmodSync(openDirectory, 0o755);
const protectedServer = createQuotaControlServer({
  socketPath: join(openDirectory, 'quota.sock'),
  manager,
});
await protectedServer.listen();
assert.equal(statSync(openDirectory).mode & 0o777, 0o755);
await protectedServer.close();

console.log('All quota-control tests passed.');
