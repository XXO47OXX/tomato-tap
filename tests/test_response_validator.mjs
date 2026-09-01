import assert from 'node:assert/strict';
import { validateOpenAIResponse } from '../src/routing/response-validator.mjs';

function jsonResult(payload, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
    networkError: null,
  };
}

function validate(payload, requestBody = {}) {
  return validateOpenAIResponse(jsonResult(payload), { requestBody });
}

assert.equal(validate({ choices: [{ message: { content: 'ok' } }] }).valid, true);
assert.equal(validate({ choices: [{ message: { content: null, refusal: 'cannot comply' } }] }).valid, true);
assert.equal(validate({ choices: [{ message: { content: null, tool_calls: [{ id: '1', type: 'function' }] } }] }).valid, true);
assert.equal(validate({ choices: [] }).failureClass, 'empty_choices');
assert.equal(validate({ error: { message: 'quota' } }).failureClass, 'wrapped_error');
assert.equal(validate({ choices: [{ message: { content: '', reasoning_content: 'thinking' } }] }).failureClass, 'reasoning_only');
assert.equal(validate({ choices: [{ message: { content: '' } }] }).failureClass, 'empty_content');
assert.equal(validateOpenAIResponse({ ...jsonResult({}), status: 503 }, { requestBody: {} }).failureClass, 'http_status');
assert.equal(validateOpenAIResponse({ ...jsonResult({}), networkError: new Error('offline') }, { requestBody: {} }).failureClass, 'network');
assert.equal(validateOpenAIResponse({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{not json'),
}, { requestBody: {} }).failureClass, 'malformed_json');

assert.equal(
  validate({ choices: [{ message: { content: '{"ok":true}' } }] }, { response_format: { type: 'json_object' } }).valid,
  true,
);
assert.equal(
  validate({ choices: [{ message: { content: 'not-json' } }] }, { response_format: { type: 'json_object' } }).failureClass,
  'invalid_json_content',
);
assert.equal(
  validate(
    { choices: [{ message: { content: '```json\n{\"ok\":true}\n```' } }] },
    { response_format: { type: 'json_object' } },
  ).valid,
  true,
);
assert.equal(
  validate(
    { choices: [{ message: { content: 'Result:\n```json\n{\"ok\":true}\n```' } }] },
    { response_format: { type: 'json_object' } },
  ).failureClass,
  'invalid_json_content',
);
assert.equal(
  validate(
    { choices: [{ message: { content: '```json\n{\"ok\":\n```' } }] },
    { response_format: { type: 'json_object' } },
  ).failureClass,
  'invalid_json_content',
);

function sseResult(lines) {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Buffer.from(lines.join('\n\n')),
    networkError: null,
  };
}

const validStream = validateOpenAIResponse(sseResult([
  'data: {"model":"real-a","choices":[{"delta":{"content":"hello"}}]}',
  'data: [DONE]',
]), { requestBody: { stream: true } });
assert.equal(validStream.valid, true);
assert.equal(validStream.finalContent, 'hello');
assert.equal(validStream.upstreamReportedModel, 'real-a');

assert.equal(validateOpenAIResponse(sseResult([
  'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
  'data: [DONE]',
]), { requestBody: { stream: true } }).failureClass, 'reasoning_only');

assert.equal(validateOpenAIResponse(sseResult([
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}',
  'data: [DONE]',
]), { requestBody: { stream: true } }).valid, true);

assert.equal(validateOpenAIResponse(sseResult([
  'data: {"choices":[{"delta":{"content":"partial"}}]}',
]), { requestBody: { stream: true } }).failureClass, 'incomplete_stream');

console.log('All response-validator tests passed.');
