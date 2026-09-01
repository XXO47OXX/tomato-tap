import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBindingStore } from '../src/egress/proxy-bindings.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mimo-bindings-'));
try {
  const path = join(dir, 'bindings.json');
  const nodes = [{ id: 'node-a' }, { id: 'node-b' }, { id: 'node-c' }];
  const store = createBindingStore({ path, portStart: 11001, portEnd: 11010 });
  store.load();

  const explicit = store.resolve('explicit', { mode: 'sticky', nodeId: 'node-b' }, nodes);
  assert.equal(explicit.nodeId, 'node-b');
  assert.equal(explicit.localPort, 11001);
  const sameNode = store.resolve('same-node', { mode: 'sticky', nodeId: 'node-b' }, nodes);
  assert.equal(sameNode.localPort, explicit.localPort, 'one node must reuse one local listener port');

  const automatic = store.resolve('automatic', { mode: 'sticky-auto', nodeId: null }, nodes);
  assert(nodes.some((node) => node.id === automatic.nodeId));
  assert.notEqual(automatic.localPort, explicit.localPort);

  const reloaded = createBindingStore({ path, portStart: 11001, portEnd: 11010 });
  reloaded.load();
  const same = reloaded.resolve('automatic', { mode: 'sticky-auto', nodeId: null }, [
    ...nodes, { id: 'node-d' },
  ]);
  assert.deepEqual(same, automatic, 'subscription growth must not rebalance');

  const withoutBoundNode = nodes.filter((node) => node.id !== automatic.nodeId);
  let unavailableError;
  try {
    reloaded.resolve('automatic', { mode: 'sticky-auto', nodeId: null }, withoutBoundNode);
  } catch (error) {
    unavailableError = error;
  }
  assert.match(unavailableError?.message || '', /bound proxy node .* unavailable/);
  assert.equal(unavailableError.nodeId, automatic.nodeId);
  assert.equal(unavailableError.localPort, automatic.localPort);

  const state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.bindings.explicit.nodeId, 'node-b');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(reloaded.snapshot().bindings.automatic, automatic);

  const rebindPath = join(dir, 'rebind.json');
  const rebindStore = createBindingStore({ path: rebindPath, portStart: 12001, portEnd: 12010 });
  rebindStore.load();
  const firstNode = rebindStore.resolve('first', { mode: 'sticky', nodeId: 'node-a' }, nodes);
  const sharedNode = rebindStore.resolve('shared', { mode: 'sticky', nodeId: 'node-a' }, nodes);
  assert.equal(firstNode.localPort, sharedNode.localPort);
  const moved = rebindStore.resolve('first', { mode: 'sticky', nodeId: 'node-b' }, nodes);
  assert.notEqual(moved.localPort, sharedNode.localPort, 'different nodes must never share a port');

  const corruptPath = join(dir, 'corrupt.json');
  writeFileSync(corruptPath, JSON.stringify({
    schemaVersion: 1,
    bindings: {
      one: { nodeId: 'node-a', localPort: 13001 },
      two: { nodeId: 'node-b', localPort: 13001 },
    },
  }));
  assert.throws(
    () => createBindingStore({ path: corruptPath }).load(),
    /different nodes share local port/,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('test_proxy_bindings: ok');
