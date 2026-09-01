import assert from 'node:assert/strict';
import { filterModelInventory, modelListPayload, parseModelQuery } from '../src/gateway/model-api.mjs';

const params = new URLSearchParams('model=GLM&available=1&task=BALANCED&details=eligibility&exclude_vendors=a,b');
const query = parseModelQuery(params);
assert.equal(query.modelFilter, 'glm');
assert.equal(query.taskName, 'balanced');
assert.equal(query.onlyAvailable, true);
assert.equal(query.includeEligibilityDetails, true);
assert.deepEqual([...query.excludedVendors], ['a', 'b']);

const inventory = [
  { id: 'glm-5.2', health: 'available', routes: [{ vendor: 'a', health: 'available' }, { vendor: 'c', health: 'probing' }] },
  { id: 'glm-5.1', health: 'available', routes: [{ vendor: 'a', health: 'available' }] },
  { id: 'unconfigured-model', health: 'available', routes: [{ vendor: 'c', health: 'available' }] },
];
assert.deepEqual(filterModelInventory(inventory, query), []);

const permissive = parseModelQuery(new URLSearchParams('model=glm&exclude_vendor=a'));
const filtered = filterModelInventory(inventory, permissive);
assert.equal(filtered.length, 1);
assert.equal(filtered[0].id, 'glm-5.2');
assert.equal(filtered[0].health, 'probing');
assert.equal(modelListPayload(filtered, permissive).count, 1);
assert.deepEqual(modelListPayload(filtered, permissive, { includeMetadata: false }), {
  object: 'list',
  data: filtered,
});

console.log('test_model_api: ok');
