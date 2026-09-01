import assert from 'node:assert/strict';
import { classify403Scope } from '../src/state/cooldown-scope.mjs';

assert.equal(
  classify403Scope({ vendor: 'relay', requestedModel: 'grok-4.5' }),
  'model',
  'relay 403 must isolate only the failing model',
);
assert.equal(
  classify403Scope({ vendor: 'relay', requestedModel: '' }),
  'key',
  'relay 403 without a model remains key-scoped',
);
assert.equal(
  classify403Scope({ vendor: 'xiaomi', requestedModel: 'mimo-v2.5' }),
  'key',
  'direct provider 403 remains key-scoped',
);

console.log('test_cooldown_scope: ok');
