import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverProviderModels,
  extractModelIds,
} from '../src/admin/provider-model-discovery.mjs';

test('extracts common upstream model-list shapes', () => {
  assert.deepEqual(extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(extractModelIds({ models: ['a', { name: 'b' }] }), ['a', 'b']);
});

test('discovers models with write-only upstream authentication', async () => {
  let request = null;
  const result = await discoverProviderModels({
    baseUrl: 'https://api.example.test/v1',
    apiFormat: 'openai',
    auth: 'bearer',
    apiKey: 'private-upstream-key',
  }, {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        data: [{ id: 'GLM-5.2' }, { id: 'glm-5.2' }, { id: 'custom/model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(request.url, 'https://api.example.test/v1/models');
  assert.equal(request.options.headers.authorization, 'Bearer private-upstream-key');
  assert.deepEqual(result.models, ['GLM-5.2', 'custom/model']);
  assert.equal(JSON.stringify(result).includes('private-upstream-key'), false);
});

test('reports invalid or empty upstream model responses', async () => {
  await assert.rejects(
    discoverProviderModels({ baseUrl: 'https://api.example.test/v1' }, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    }),
    /no model IDs/,
  );
});
