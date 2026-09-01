import assert from 'node:assert/strict';
import {
  adaptLogicalRequest,
  adaptRelayRequest,
  validateRequestPolicyInput,
} from '../src/routing/request-adapter.mjs';

const headers = { 'content-type': 'application/json' };
const source = Buffer.from(JSON.stringify({
  model: 'balanced',
  messages: [{ role: 'user', content: 'x' }],
}));

function parse(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

assert.deepEqual(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'glm-5.2',
    thinkingAdapter: 'glm_disabled',
  })),
  {
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'x' }],
    chat_template_kwargs: { enable_thinking: false },
  },
);

assert.deepEqual(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'kimi-k3',
    thinkingAdapter: 'kimi_low',
    logicalRequestPolicy: {
      reasoningEffort: 'high',
      temperature: 0,
      stream: false,
      maxOutputTokens: 100,
    },
    requestPolicy: {
      reasoningEffort: 'max',
      temperature: 0.25,
      stream: true,
      maxOutputTokens: 50,
    },
  })),
  {
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'x' }],
    reasoning_effort: 'max',
    temperature: 0.25,
    stream: true,
    max_tokens: 50,
  },
  'provider policy must remain the final guardrail after logical and model policy',
);

assert.equal(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'reasoning-model',
    thinkingAdapter: 'none',
    maxTokensMultiplier: 3,
    logicalRequestPolicy: { maxOutputTokens: 100 },
  })).max_tokens,
  300,
  'real-model token compensation applies after the logical output target',
);

assert.equal(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'unconfigured-model',
    thinkingAdapter: 'none',
  })).thinking,
  undefined,
);

assert.deepEqual(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'glm-5.2',
    thinkingAdapter: 'glm_disabled',
    requestPolicy: { reasoningEffort: 'none' },
  })),
  {
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'x' }],
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'none',
  },
);

assert.deepEqual(
  parse(adaptRelayRequest(source, headers, { reasoningEffort: 'none' })),
  {
    model: 'balanced',
    messages: [{ role: 'user', content: 'x' }],
    reasoning_effort: 'none',
  },
);
assert.deepEqual(
  parse(adaptRelayRequest(source, headers, {
    maxOutputTokens: 10,
  })),
  {
    model: 'balanced',
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 10,
  },
);
assert.deepEqual(
  parse(adaptRelayRequest(
    Buffer.from(JSON.stringify({
      model: 'balanced',
      messages: [{ role: 'user', content: 'x' }],
      max_completion_tokens: 999,
      max_tokens: 1234,
    })),
    headers,
    {
      maxOutputTokens: 500,
    },
  )),
  {
    model: 'balanced',
    messages: [{ role: 'user', content: 'x' }],
    max_completion_tokens: 500,
    max_tokens: 500,
  },
);
assert.equal(adaptRelayRequest(source, headers, null), source);
assert.throws(
  () => adaptRelayRequest(Buffer.from(JSON.stringify({
    model: 'balanced',
    messages: [{ role: 'user', content: 'x'.repeat(200000) }],
  })), headers, { maxInputTokens: 1 }),
  /input budget exceeded/i,
);
assert.throws(
  () => validateRequestPolicyInput(
    Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(100) }] })),
    headers,
    { maxInputTokens: 1 },
  ),
  /input budget exceeded/i,
);
assert.doesNotThrow(() => validateRequestPolicyInput(source, headers, null));
assert.throws(
  () => validateRequestPolicyInput(
    Buffer.from(JSON.stringify({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '中文输入测试' }],
      }],
    })),
    headers,
    { maxInputTokens: 4 },
  ),
  /input budget exceeded/i,
);

const withTokenBudget = Buffer.from(JSON.stringify({
  model: 'concise',
  messages: [{ role: 'user', content: 'x' }],
  max_tokens: 400,
  max_completion_tokens: 300,
}));
assert.deepEqual(
  parse(adaptLogicalRequest(withTokenBudget, headers, {
    upstreamModel: 'step-3.5-flash',
    thinkingAdapter: 'none',
    maxTokensMultiplier: 3,
  })),
  {
    model: 'step-3.5-flash',
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 1200,
    max_completion_tokens: 900,
  },
);

assert.deepEqual(
  parse(adaptLogicalRequest(withTokenBudget, headers, {
    upstreamModel: 'unconfigured-model',
    thinkingAdapter: 'none',
  })),
  {
    model: 'unconfigured-model',
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 400,
    max_completion_tokens: 300,
  },
);

const edgeTokenBudget = Buffer.from(JSON.stringify({
  model: 'concise',
  messages: [],
  max_tokens: 3,
  max_completion_tokens: 0,
}));
assert.deepEqual(
  parse(adaptLogicalRequest(edgeTokenBudget, headers, {
    upstreamModel: 'step-3.5-flash',
    thinkingAdapter: 'none',
    maxTokensMultiplier: 1.5,
  })),
  {
    model: 'step-3.5-flash',
    messages: [],
    max_tokens: 5,
    max_completion_tokens: 0,
  },
);

const overflowingTokenBudget = Buffer.from(JSON.stringify({
  model: 'concise',
  messages: [],
  max_tokens: Number.MAX_VALUE,
}));
assert.throws(
  () => adaptLogicalRequest(overflowingTokenBudget, headers, {
    upstreamModel: 'step-3.5-flash',
    thinkingAdapter: 'none',
    maxTokensMultiplier: 3,
  }),
  /safe token budget/i,
);

assert.deepEqual(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'deepseek-v4-pro',
    thinkingAdapter: 'deepseek_disabled',
  })).thinking,
  { type: 'disabled' },
);

assert.deepEqual(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'LongCat-2.0',
    thinkingAdapter: 'longcat_disabled',
  })).thinking,
  { type: 'disabled' },
);

assert.equal(
  parse(adaptLogicalRequest(source, headers, {
    upstreamModel: 'minimax-m3',
    thinkingAdapter: 'minimax_split',
  })).reasoning_split,
  true,
);

const withTemplate = Buffer.from(JSON.stringify({
  model: 'classifier',
  messages: [],
  chat_template_kwargs: { custom: 'keep', enable_thinking: true },
}));
assert.deepEqual(
  parse(adaptLogicalRequest(withTemplate, headers, {
    upstreamModel: 'glm-5.2',
    thinkingAdapter: 'glm_disabled',
  })).chat_template_kwargs,
  { custom: 'keep', enable_thinking: false },
);

assert.throws(
  () => adaptLogicalRequest(source, { 'content-type': 'text/plain' }, {
    upstreamModel: 'unconfigured-model',
    thinkingAdapter: 'none',
  }),
  /require JSON/i,
);
assert.throws(
  () => adaptLogicalRequest(source, headers, {
    upstreamModel: 'unconfigured-model',
    thinkingAdapter: 'mystery',
  }),
  /unknown thinking adapter/i,
);

assert.equal(parse(source).model, 'balanced');

console.log('All request-adapter tests passed.');
