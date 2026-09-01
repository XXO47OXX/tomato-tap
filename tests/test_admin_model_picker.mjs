import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeModelValues,
  parseModelImport,
} from '../src/admin/web/model-picker.js';

test('model import accepts text and OpenAI-compatible models JSON', () => {
  assert.deepEqual(
    parseModelImport('model-a\n- model-b, model-c'),
    ['model-a', 'model-b', 'model-c'],
  );
  assert.deepEqual(
    parseModelImport(JSON.stringify({ data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4-flash' }] })),
    ['glm-5.2', 'deepseek-v4-flash'],
  );
  assert.deepEqual(
    parseModelImport(JSON.stringify({ models: ['custom/unknown-model'] })),
    ['custom/unknown-model'],
  );
});

test('model picker preserves exact first spelling and reports case-insensitive duplicates', () => {
  const result = normalizeModelValues(
    ['GLM-5.2', 'glm-5.2', 'custom/new', 'bad\nname'],
    ['existing'],
  );
  assert.deepEqual(result.accepted, ['GLM-5.2', 'custom/new']);
  assert.deepEqual(result.duplicates, ['glm-5.2']);
  assert.deepEqual(result.invalid, ['bad\nname']);
});
