import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelRouteHash,
  parseAdminHash,
  readModelRouteState,
} from '../src/admin/web/route-state.js';

test('admin hash parser keeps route and query parameters separate', () => {
  const parsed = parseAdminHash('#/models?view=key&logical=classifier');
  assert.equal(parsed.route, 'models');
  assert.equal(parsed.params.get('view'), 'key');
  assert.equal(parsed.params.get('logical'), 'classifier');
});

test('model relationship state round-trips through a shareable URL', () => {
  const hash = buildModelRouteHash({
    perspective: 'key',
    query: 'example model',
    focus: {
      logical: 'classifier',
      real: 'glm-5.2',
      vendor: 'example-vendor',
      provider: 'provider-a',
      key: 'key-001',
      egress: 'mode:direct',
    },
  });
  const state = readModelRouteState(hash);
  assert.equal(state.route, 'models');
  assert.equal(state.perspective, 'key');
  assert.equal(state.query, 'example model');
  assert.deepEqual(state.focus, {
    logical: 'classifier',
    real: 'glm-5.2',
    vendor: 'example-vendor',
    provider: 'provider-a',
    key: 'key-001',
    egress: 'mode:direct',
  });
});

test('unknown relationship perspective falls back safely', () => {
  assert.equal(readModelRouteState('#models?view=unknown').perspective, 'logical');
});
