// Regression tests for Claude OAuth/OpenAI-compatible adapter.
//
// Run with: node tests/test_claude_oauth_compat.mjs

import {
  anthropicMessagesToOpenAIChat,
  openAIChatToAnthropicMessage,
} from '../src/providers/adapters/claude_oauth_compat.mjs';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    console.error('actual  ', JSON.stringify(actual));
    console.error('expected', JSON.stringify(expected));
    failures++;
  }
}

const req = anthropicMessagesToOpenAIChat(Buffer.from(JSON.stringify({
  model: 'claude-sonnet-4-6',
  system: 'You are terse.',
  max_tokens: 32,
  temperature: 0.2,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: 'hi' },
  ],
})));
const reqJson = JSON.parse(req.toString('utf8'));
check('request.model', reqJson.model, 'claude-sonnet-4-6');
check('request.max_tokens', reqJson.max_tokens, 32);
check('request.temperature', reqJson.temperature, 0.2);
check('request.messages', reqJson.messages, [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
]);

const transformed = openAIChatToAnthropicMessage({
  status: 200,
  statusMessage: 'OK',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({
    id: 'chatcmpl_1',
    model: 'claude-sonnet-4-6',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  })),
}, 'claude-sonnet-4-6');
const resJson = JSON.parse(transformed.body.toString('utf8'));
check('response.status', transformed.status, 200);
check('response.type', resJson.type, 'message');
check('response.role', resJson.role, 'assistant');
check('response.content', resJson.content, [{ type: 'text', text: 'ok' }]);
check('response.usage', resJson.usage, { input_tokens: 11, output_tokens: 3 });

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll claude-oauth compatibility tests passed.');
