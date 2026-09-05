import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQuotaState, saveQuotaState } from '../src/providers/quota/quota-state-store.mjs';

function tempStatePath() {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-quota-state-'));
  return { dir, path: join(dir, 'runtime', 'quota-windows.json') };
}

const window = {
  deploymentId: 'quota-a',
  state: 'closed',
  closedReason: 'usage_limit',
  closedAt: 100,
  nextProbeAt: 200,
  openedAt: 0,
  boostedUntil: 0,
  lastProbeStatus: 429,
  consecutiveProbeFailures: 1,
};
const classifiedWindow = { ...window, deploymentId: 'quota-b', closedKind: 'quota' };

{
  const { path } = tempStatePath();
  assert.deepEqual(loadQuotaState(path), { corrupt: false, windows: [] });
}

{
  const { dir, path } = tempStatePath();
  const runtime = join(dir, 'runtime');
  mkdirSync(runtime, { mode: 0o755 });
  chmodSync(runtime, 0o755);
  saveQuotaState(path, [], 1);
  assert.equal(statSync(runtime).mode & 0o777, 0o755);
}

{
  const { dir, path } = tempStatePath();
  saveQuotaState(path, [{ ...window }], 1234);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.updatedAt, 1234);
  assert.deepEqual(raw.windows, [window]);
  assert.deepEqual(loadQuotaState(path), { corrupt: false, windows: [window] });
  assert.equal(readdirSync(join(dir, 'runtime')).some((name) => name.includes('.tmp-')), false);
  assert.equal(statSync(join(dir, 'runtime')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
}

{
  const { path } = tempStatePath();
  saveQuotaState(path, [classifiedWindow], 1234);
  assert.deepEqual(loadQuotaState(path).windows, [classifiedWindow]);
  assert.throws(
    () => saveQuotaState(path, [{ ...classifiedWindow, closedKind: 'network' }], 1234),
    /invalid closedKind/i,
  );
}

{
  const { path } = tempStatePath();
  assert.throws(() => saveQuotaState(path, [{
    ...window,
    apiKey: 'must-not-persist',
  }], 1234), /unknown field/i);
}

for (const invalidDocument of [
  '{bad json',
  JSON.stringify({ schemaVersion: 99, updatedAt: 1, windows: [] }),
]) {
  const { dir, path } = tempStatePath();
  const runtime = join(dir, 'runtime');
  saveQuotaState(path, [], 1);
  writeFileSync(path, invalidDocument, { mode: 0o600 });
  assert.deepEqual(loadQuotaState(path), { corrupt: true, windows: [] });
  const names = readdirSync(runtime);
  assert.equal(names.some((name) => name.startsWith('quota-windows.json.corrupt-')), true);
  assert.equal(names.includes('quota-windows.json'), false);
}

console.log('All quota-state-store tests passed.');
