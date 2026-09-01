import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractRequestModel,
  extractUsage,
  rewriteRequestModel,
  stripEmptyUserMessagesForOpenAI,
  validateLogicalClientRequest,
  validateOpenAIChatRequest,
} from '../src/gateway/request-body.mjs';

test('request model extraction and rewrite preserve the JSON envelope', () => {
  const original = Buffer.from(JSON.stringify({
    model: 'logical-name',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0,
  }));
  assert.equal(extractRequestModel(original), 'logical-name');

  const rewritten = rewriteRequestModel(original, { 'content-type': 'application/json' }, 'native-name');
  assert.deepEqual(JSON.parse(rewritten), {
    model: 'native-name',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0,
  });
  assert.equal(extractRequestModel(original), 'logical-name');
});

test('OpenAI sanitizer removes empty user turns before validation', () => {
  const warnings = [];
  const original = Buffer.from(JSON.stringify({
    model: 'test',
    messages: [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: [{ type: 'text', text: ' next ' }] },
    ],
  }));

  assert.match(validateOpenAIChatRequest(original), /must not be empty/);
  const sanitized = stripEmptyUserMessagesForOpenAI(original, '/direct', {
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(validateOpenAIChatRequest(sanitized), '');
  assert.deepEqual(JSON.parse(sanitized).messages, [
    { role: 'assistant', content: 'prior reply' },
    { role: 'user', content: 'next' },
  ]);
  assert.equal(warnings.length, 1);
});

test('logical request validation requires JSON model and messages', () => {
  const body = Buffer.from('{"model":"balanced","messages":[{"role":"user","content":"x"}]}');
  assert.equal(validateLogicalClientRequest(body, { 'content-type': 'application/json' }), '');
  assert.match(validateLogicalClientRequest(body, { 'content-type': 'text/plain' }), /Content-Type/);
});

test('usage extraction handles OpenAI JSON and cumulative SSE', () => {
  assert.deepEqual(extractUsage(Buffer.from(JSON.stringify({
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 8 },
    },
  })), 'application/json'), {
    input: 20,
    output: 5,
    inputCached: 8,
    inputMiss: 12,
  });

  const sse = Buffer.from([
    'data: {"usage":{"input_tokens":10,"output_tokens":2}}',
    'data: {"usage":{"input_tokens":10,"output_tokens":7,"prompt_cache_hit_tokens":4}}',
    'data: [DONE]',
    '',
  ].join('\n'));
  assert.deepEqual(extractUsage(sse, 'text/event-stream'), {
    input: 10,
    output: 7,
    inputCached: 4,
    inputMiss: 6,
  });
});
