import assert from 'node:assert/strict';
import { annotateResponse } from '../src/routing/response-metadata.mjs';

const meta = {
  requestedModel: 'balanced',
  taskName: 'structured-generation',
  selectedModel: 'glm-5.2',
  resolvedModel: 'z-ai/glm-5.2',
  upstreamReportedModel: 'z-ai/glm-5.2',
  deploymentId: 'provider-slot-a',
  vendor: 'relay',
  attempts: 2,
  modelSwitched: true,
};

const source = {
  status: 200,
  statusMessage: 'OK',
  headers: { 'content-type': 'application/json', 'content-length': '1' },
  body: Buffer.from(JSON.stringify({
    model: 'old',
    choices: [{ message: { content: 'ok' } }],
    usage: { total_tokens: 3 },
  })),
  networkError: null,
};
const output = annotateResponse(source, meta);
const payload = JSON.parse(output.body.toString('utf8'));
assert.equal(payload.model, 'z-ai/glm-5.2');
assert.equal(payload.choices[0].message.content, 'ok');
assert.equal(payload.usage.total_tokens, 3);
assert.deepEqual(payload.mimo_tap, {
  requested_model: 'balanced',
  task: 'structured-generation',
  selected_model: 'glm-5.2',
  resolved_model: 'z-ai/glm-5.2',
  upstream_reported_model: 'z-ai/glm-5.2',
  deployment: 'provider-slot-a',
  vendor: 'relay',
  attempts: 2,
  model_switched: true,
});
assert.deepEqual(payload.tomato_tap, payload.mimo_tap);
assert.equal(output.headers['x-tomato-tap-requested-model'], 'balanced');
assert.equal(output.headers['x-tomato-tap-resolved-model'], 'z-ai/glm-5.2');
assert.equal(output.headers['content-length'], String(output.body.length));
assert.equal(output.headers['x-mimo-requested-model'], 'balanced');
assert.equal(output.headers['x-mimo-task'], 'structured-generation');
assert.equal(output.headers['x-mimo-selected-model'], 'glm-5.2');
assert.equal(output.headers['x-mimo-resolved-model'], 'z-ai/glm-5.2');
assert.equal(output.headers['x-mimo-upstream-reported-model'], 'z-ai/glm-5.2');
assert.equal(output.headers['x-mimo-deployment'], 'provider-slot-a');
assert.equal(output.headers['x-mimo-vendor'], 'relay');
assert.equal(output.headers['x-mimo-attempts'], '2');
assert.equal(output.headers['x-mimo-model-switched'], '1');
assert.equal(output.body.includes(source.body), false);

const streamBody = Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
const stream = annotateResponse({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: streamBody,
}, meta);
assert.deepEqual(stream.body, streamBody);
assert.equal(stream.headers['x-mimo-resolved-model'], 'z-ai/glm-5.2');

const serialized = JSON.stringify({ headers: output.headers, payload });
assert.equal(serialized.includes('sk-'), false);
assert.equal(serialized.includes('Bearer '), false);

console.log('All response-metadata tests passed.');
