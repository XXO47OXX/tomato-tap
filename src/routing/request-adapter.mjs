export function adaptLogicalRequest(
  buffer,
  headers,
  {
    upstreamModel,
    thinkingAdapter,
    maxTokensMultiplier = 1,
    logicalRequestPolicy = null,
    requestPolicy = null,
  },
) {
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) {
    throw new Error('logical model requests require JSON');
  }

  const body = JSON.parse(buffer.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('logical request body must be an object');
  }
  body.model = upstreamModel;

  // Logical/task policy expresses downstream intent. Model adaptation then
  // enforces physical-model compatibility, and the deployment policy remains
  // the final provider-specific guardrail.
  applyRequestPolicy(body, logicalRequestPolicy);

  for (const field of ['max_tokens', 'max_completion_tokens']) {
    if (Number.isFinite(body[field]) && body[field] > 0 && maxTokensMultiplier !== 1) {
      const scaled = Math.ceil(body[field] * maxTokensMultiplier);
      if (!Number.isSafeInteger(scaled) || scaled <= 0) {
        throw new Error(`${field} multiplier produced an unsafe token budget`);
      }
      body[field] = scaled;
    }
  }

  switch (thinkingAdapter) {
    case 'none':
      break;
    case 'glm_disabled':
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: false,
      };
      break;
    case 'deepseek_disabled':
      body.thinking = { type: 'disabled' };
      break;
    case 'longcat_disabled':
      body.thinking = { type: 'disabled' };
      break;
    case 'minimax_split':
      body.reasoning_split = true;
      break;
    case 'kimi_low':
      body.reasoning_effort = 'low';
      break;
    default:
      throw new Error(`unknown thinking adapter ${thinkingAdapter}`);
  }

  applyRequestPolicy(body, requestPolicy);

  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function adaptRelayRequest(buffer, headers, requestPolicy) {
  if (!requestPolicy) return buffer;
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) {
    throw new Error('relay request policy requires JSON');
  }
  const body = JSON.parse(buffer.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('relay request body must be an object');
  }
  applyRequestPolicy(body, requestPolicy);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function validateRequestPolicyInput(buffer, headers, requestPolicy) {
  if (!Number.isFinite(requestPolicy?.maxInputTokens)) return;
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) {
    throw new Error('request input policy requires JSON');
  }
  const body = JSON.parse(buffer.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('request input policy requires an object');
  }
  enforceInputBudget(body, requestPolicy.maxInputTokens);
}

function applyRequestPolicy(body, requestPolicy) {
  if (!requestPolicy) return;
  if (requestPolicy.reasoningEffort) {
    body.reasoning_effort = requestPolicy.reasoningEffort;
  }
  if (Number.isFinite(requestPolicy.temperature)) {
    body.temperature = requestPolicy.temperature;
  }
  if (typeof requestPolicy.stream === 'boolean') {
    body.stream = requestPolicy.stream;
  }
  if (Number.isFinite(requestPolicy.maxOutputTokens)) {
    if (!Number.isFinite(body.max_tokens) && !Number.isFinite(body.max_completion_tokens)) {
      body.max_tokens = requestPolicy.maxOutputTokens;
    }
    if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) {
      body.max_tokens = Math.min(body.max_tokens, requestPolicy.maxOutputTokens);
    }
    if (Number.isFinite(body.max_completion_tokens) && body.max_completion_tokens > 0) {
      body.max_completion_tokens = Math.min(
        body.max_completion_tokens,
        requestPolicy.maxOutputTokens,
      );
    }
  }
  if (Number.isFinite(requestPolicy.maxInputTokens)) {
    enforceInputBudget(body, requestPolicy.maxInputTokens);
  }
}

function enforceInputBudget(body, maxInputTokens) {
  const estimated = [body.system, body.messages, body.input, body.prompt]
    .reduce((total, value) => total + estimateInputTokens(value), 0);
  if (estimated > maxInputTokens) {
    throw new Error('request input budget exceeded for configured policy');
  }
}

function estimateInputTokens(value) {
  if (typeof value === 'string') {
    let ascii = 0;
    let nonAscii = 0;
    for (const character of value) {
      if (character.codePointAt(0) <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
    return Math.ceil(ascii / 4) + nonAscii;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateInputTokens(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value)
      .reduce((total, item) => total + estimateInputTokens(item), 0);
  }
  return 0;
}
