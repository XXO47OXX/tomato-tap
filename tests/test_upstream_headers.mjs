import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpstreamHeaderPolicy } from '../src/providers/upstream-headers.mjs';

const buildHeaders = createUpstreamHeaderPolicy();

test('normalizes transport headers and preserves downstream user agent by default', () => {
  const headers = buildHeaders(
    {
      authorization: 'downstream-secret',
      host: 'client.invalid',
      connection: 'keep-alive',
      'x-stainless-runtime': 'node',
      'x-client-header': 'kept',
      'x-mimo-task': 'internal',
      'x-tomato-tap-task': 'internal-new',
      'user-agent': 'incoming/1',
    },
    'openai',
    'relay',
    'api.example.com',
    { headers: { authorization: 'Bearer upstream', 'x-provider': 'a' } },
  );

  assert.equal(headers.Host, 'api.example.com');
  assert.equal(headers['user-agent'], 'incoming/1');
  assert.equal(headers['Accept-Encoding'], 'identity');
  assert.equal(headers.authorization, 'Bearer upstream');
  assert.equal(headers['x-provider'], 'a');
  assert.equal(headers['x-client-header'], 'kept');
  assert.equal(headers.connection, undefined);
  assert.equal(headers['x-mimo-task'], undefined);
  assert.equal(headers['x-tomato-tap-task'], undefined);
  assert.equal(headers['x-stainless-runtime'], undefined);
});

test('an explicit deployment user agent overrides the downstream value', () => {
  const headers = buildHeaders(
    { 'user-agent': 'incoming/1' },
    'openai',
    'relay',
    'api.example.com',
    { headers: { 'User-Agent': 'supported-client/2' } },
  );
  assert.equal(headers['user-agent'], undefined);
  assert.equal(headers['User-Agent'], 'supported-client/2');
});

test('blank deployment user agent does not add a header when downstream omitted it', () => {
  const headers = buildHeaders(
    {},
    'openai',
    'relay',
    'api.example.com',
    { headers: {} },
  );
  assert.equal(headers['user-agent'], undefined);
  assert.equal(headers['User-Agent'], undefined);
});

test('configured global user agent is only a fallback for a missing downstream header', () => {
  const withFallback = createUpstreamHeaderPolicy({ defaultUserAgent: 'fallback/1' });
  const preserved = withFallback(
    { 'user-agent': 'incoming/2' }, 'openai', 'relay', 'api.example.com', { headers: {} },
  );
  const missing = withFallback(
    {}, 'openai', 'relay', 'api.example.com', { headers: {} },
  );
  assert.equal(preserved['user-agent'], 'incoming/2');
  assert.equal(preserved['User-Agent'], undefined);
  assert.equal(missing['User-Agent'], 'fallback/1');
});

test('preserves direct bridge user agent and adds Anthropic version', () => {
  const headers = buildHeaders(
    { 'user-agent': 'client/2', accept: 'application/json' },
    'anthropic',
    'relay',
    'api.example.com',
    null,
    { preserveIncomingUserAgent: true },
  );
  assert.equal(headers['user-agent'], 'client/2');
  assert.equal(headers['Accept-Encoding'], undefined);
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('applies the Codex Responses header profile', () => {
  const headers = buildHeaders(
    {},
    'openai_responses',
    'chatgpt_codex',
    'chatgpt.example.com',
    { chatgptAccountId: 'account-example' },
  );
  assert.equal(headers['User-Agent'], 'codex_cli_rs/0.125.0');
  assert.equal(headers.Accept, 'text/event-stream');
  assert.equal(headers['openai-beta'], 'responses=experimental');
  assert.equal(headers['chatgpt-account-id'], 'account-example');
});
