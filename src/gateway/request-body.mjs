export function safeJsonParse(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

export function extractRequestModel(requestBuffer) {
  const body = safeJsonParse(requestBuffer);
  return body && typeof body.model === 'string' ? body.model : '';
}

export function validateLogicalClientRequest(requestBuffer, headers) {
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) return 'logical model requests require Content-Type: application/json';
  const body = safeJsonParse(requestBuffer);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'logical request body must be a JSON object';
  if (typeof body.model !== 'string' || !body.model.trim()) return 'logical request body requires model';
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'logical chat-completions request requires a non-empty messages[]';
  }
  return '';
}

export function validateOpenAIChatRequest(bodyBuffer) {
  const body = safeJsonParse(bodyBuffer);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'openai request body must be a JSON object';
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'openai request requires a non-empty messages[]';
  }
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index] || {};
    if (!['user', 'assistant', 'system'].includes(message.role)) continue;
    const content = contentTextForOpenAIValidation(message.content);
    if (message.role === 'user' && !content.trim()) {
      return `the message at position ${index} with role 'user' must not be empty`;
    }
  }
  return '';
}

export function stripEmptyUserMessagesForOpenAI(bodyBuffer, routePrefix = '', { logger = console } = {}) {
  const body = safeJsonParse(bodyBuffer);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bodyBuffer;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return bodyBuffer;

  let dropped = 0;
  const messages = [];
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user') {
      messages.push(message);
      continue;
    }
    const text = contentTextForOpenAIValidation(message.content).trim();
    if (!text) {
      dropped += 1;
      continue;
    }
    messages.push({ ...message, content: text });
  }
  if (dropped === 0) return bodyBuffer;

  logger.warn(
    `[proxy] stripped ${dropped} empty user message(s) before openai validation ` +
    `route=${routePrefix} model=${body.model || '<none>'}`,
  );
  return Buffer.from(JSON.stringify({ ...body, messages }));
}

export function rewriteRequestModel(requestBuffer, headers, newModel) {
  if (requestBuffer.length === 0 || !newModel) return requestBuffer;
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) return requestBuffer;
  const body = safeJsonParse(requestBuffer);
  if (!body || typeof body !== 'object' || typeof body.model !== 'string') return requestBuffer;
  body.model = newModel;
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function extractUsage(responseBuffer, contentType) {
  const text = responseBuffer.toString('utf8');
  const isSSE = String(contentType || '').toLowerCase().includes('text/event-stream')
    || text.startsWith('data:')
    || text.includes('\ndata:');
  if (!isSSE) {
    const body = safeJsonParse(responseBuffer);
    if (!body) return emptyUsage();
    return normalizeUsage(body.usage || {});
  }

  let input = 0;
  let output = 0;
  let inputCached = 0;
  let inputMiss = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    const usage = event.usage || event.message?.usage || event.delta?.usage;
    if (!usage) continue;
    if (typeof usage.input_tokens === 'number') input = Math.max(input, usage.input_tokens);
    if (typeof usage.output_tokens === 'number') output = Math.max(output, usage.output_tokens);
    if (typeof usage.prompt_tokens === 'number') input = Math.max(input, usage.prompt_tokens);
    if (typeof usage.completion_tokens === 'number') output = Math.max(output, usage.completion_tokens);
    if (typeof usage.prompt_cache_hit_tokens === 'number') inputCached = Math.max(inputCached, usage.prompt_cache_hit_tokens);
    if (typeof usage.prompt_cache_miss_tokens === 'number') inputMiss = Math.max(inputMiss, usage.prompt_cache_miss_tokens);
    if (typeof usage.input_tokens_details?.cached_tokens === 'number') inputCached = Math.max(inputCached, usage.input_tokens_details.cached_tokens);
    if (typeof usage.prompt_tokens_details?.cached_tokens === 'number') inputCached = Math.max(inputCached, usage.prompt_tokens_details.cached_tokens);
  }
  if (inputMiss <= 0) inputMiss = Math.max(0, input - inputCached);
  return { input, output, inputCached, inputMiss };
}

function contentTextForOpenAIValidation(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
    return '';
  }).join('\n');
}

function emptyUsage() {
  return { input: 0, output: 0, inputCached: 0, inputMiss: 0 };
}

function normalizeUsage(usage) {
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const inputCached = Number(
    usage.prompt_cache_hit_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0
  ) || 0;
  const explicitMiss = Number(usage.prompt_cache_miss_tokens ?? 0) || 0;
  const inputMiss = explicitMiss > 0 ? explicitMiss : Math.max(0, input - inputCached);
  return { input, output, inputCached, inputMiss };
}
