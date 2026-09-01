import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntimeGenerationManager } from '../src/config/runtime-generation.mjs';

let idle = true;
const activated = [];
const manager = createRuntimeGenerationManager({
  initialRevision: 'one',
  prepare: async (candidate) => ({ value: candidate.value * 2 }),
  activate: (candidate, prepared) => activated.push([candidate.revision, prepared.value]),
  isIdle: () => idle,
  logger: { log() {}, error() {} },
});

const response = new EventEmitter();
manager.trackResponse(response);
await manager.stage({ revision: 'two', value: 3 });
assert.equal(manager.status().active_revision, 'one');
assert.equal(manager.status().pending_revision, 'two');
const waiting = manager.waitForActivation(1000);
assert.equal(manager.status().waiting_requests, 1);
response.emit('finish');
assert.equal(await waiting, true);
assert.equal(manager.status().active_revision, 'two');
assert.equal(manager.status().waiting_requests, 0);
assert.deepEqual(activated, [['two', 6]]);

idle = false;
await manager.stage({ revision: 'three', value: 4 });
assert.equal(manager.tryActivate(), false);
assert.equal(await manager.waitForActivation(5), false);
idle = true;
assert.equal(manager.tryActivate(), true);
assert.equal(manager.status().active_revision, 'three');

manager.recordError(new Error('bad sk-secret-value'));
assert.equal(manager.status().last_error.includes('secret-value'), false);

console.log('test_runtime_generation: ok');
