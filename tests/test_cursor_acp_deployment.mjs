import assert from 'node:assert/strict';
import { appendCursorAcpDeployment } from '../src/providers/adapters/cursor-acp-deployment.mjs';

assert.deepEqual(appendCursorAcpDeployment([], { enabled: false }), []);
assert.deepEqual(appendCursorAcpDeployment([], { enabled: true }), []);

const [deployment] = appendCursorAcpDeployment([], {
  enabled: true,
  host: '127.0.0.1',
  port: 8891,
  maxConcurrent: 3,
  apiKey: 'example-cursor-key',
});
assert.equal(deployment.vendor, 'cursor_acp');
assert.equal(deployment.host, '127.0.0.1');
assert.equal(deployment.port, 8891);
assert.equal(deployment.pathPrefix, '/v1');
assert.equal(deployment.modelSet.has('cursor-agent'), true);
assert.equal(deployment.capInitial, 3);
assert.equal(deployment.capMax, 3);

const existing = {
  vendor: 'cursor_acp', deploymentId: 'operator-defined', host: '127.0.0.1',
  port: 8891, pathPrefix: '/v1', modelSet: new Set(['cursor-agent']),
};
assert.deepEqual(
  appendCursorAcpDeployment([existing], { enabled: true, apiKey: 'example-cursor-key' }),
  [existing],
);

const [replacedLegacy] = appendCursorAcpDeployment([{
  vendor: 'cursor_acp', deploymentId: 'legacy', name: 'mimotap_cursor_acp_credential',
  host: '127.0.0.1', modelSet: null,
}], { enabled: true, apiKey: 'example-cursor-key' });
assert.equal(replacedLegacy.deploymentId, 'cursor-acp-local');

console.log('test_cursor_acp_deployment: ok');

