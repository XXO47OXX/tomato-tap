// claude_oauth_compat.mjs
//
// Adapter for clients that speak Anthropic Messages while the upstream is an
// OpenAI-compatible /v1/chat/completions relay carrying Claude models.

export function anthropicMessagesToOpenAIChat(reqBuf) {
  const src = safeJson(reqBuf);
  if (!src || typeof src !== 'object') return reqBuf;
  const out = {
    model: src.model,
    messages: [],
  };
  const systemText = contentToText(src.system);
  if (systemText) out.messages.push({ role: 'system', content: systemText });
  for (const m of Array.isArray(src.messages) ? src.messages : []) {
    const role = normalizeRole(m?.role);
    const text = contentToText(m.content).trim();
    if (text.length === 0) {
      // OpenAI chat rejects empty user turns.
      continue;
    }
    if (!['system', 'assistant', 'user'].includes(role)) {
      continue;
    }
    out.messages.push({ role, content: text });
  }
  if (typeof src.max_tokens === 'number') out.max_tokens = src.max_tokens;
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (Array.isArray(src.stop_sequences)) out.stop = src.stop_sequences;
  if (src.stream === true) out.stream = true;
  return Buffer.from(JSON.stringify(out));
}

function normalizeRole(role) {
  if (role === 'assistant' || role === 'system') return role;
  if (role === 'user') return 'user';
  return role || 'user';
}

export function openAIChatToAnthropicMessage(result, fallbackModel = '') {
  if (!result || result.networkError || result.status < 200 || result.status >= 300) {
    return result;
  }
  const src = safeJson(result.body);
  if (!src || typeof src !== 'object') return result;
  const choice = Array.isArray(src.choices) ? src.choices[0] : null;
  const msg = choice?.message || {};
  const text = contentToText(msg.content);
  const usage = src.usage || {};
  const body = {
    id: typeof src.id === 'string' ? src.id : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: typeof src.model === 'string' ? src.model : fallbackModel,
    content: [{ type: 'text', text }],
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    },
  };
  return {
    ...result,
    headers: {
      ...result.headers,
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function safeJson(buf) {
  try {
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || ''));
  } catch {
    return null;
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function mapFinishReason(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  return 'end_turn';
}
