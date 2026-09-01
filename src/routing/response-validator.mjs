export function validateOpenAIResponse(result, { requestBody = {} } = {}) {
  if (result.networkError) return invalid('network');
  if (result.status < 200 || result.status >= 300) return invalid('http_status');
  if (isSse(result)) return validateSse(result, requestBody);

  const payload = parseJsonBody(result.body);
  if (!payload) return invalid('malformed_json');
  if (payload.error) return invalid('wrapped_error', { upstreamReportedModel: modelName(payload) });
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return invalid('empty_choices', { upstreamReportedModel: modelName(payload) });
  }
  return validateChoices(payload, requestBody);
}

function validateChoices(payload, requestBody) {
  let finalContent = '';
  let hasRefusal = false;
  let hasToolCall = false;
  let hasReasoning = false;

  for (const choice of payload.choices) {
    const message = choice?.message || choice?.delta || {};
    finalContent += contentToText(message.content);
    hasRefusal ||= Boolean(contentToText(message.refusal).trim());
    hasToolCall ||= Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    hasReasoning ||= Boolean(contentToText(
      message.reasoning_content ?? message.reasoning ?? choice?.reasoning_content,
    ).trim());
  }

  if (hasToolCall || hasRefusal) {
    return valid({
      upstreamReportedModel: modelName(payload),
      finalContent,
      isStream: false,
    });
  }
  if (!finalContent.trim()) {
    return invalid(hasReasoning ? 'reasoning_only' : 'empty_content', {
      upstreamReportedModel: modelName(payload),
      finalContent,
    });
  }
  if (requiresJsonContent(requestBody) && !parseJsonContent(finalContent)) {
    return invalid('invalid_json_content', {
      upstreamReportedModel: modelName(payload),
      finalContent,
    });
  }
  return valid({
    upstreamReportedModel: modelName(payload),
    finalContent,
    isStream: false,
  });
}

function validateSse(result, requestBody) {
  const text = Buffer.isBuffer(result.body)
    ? result.body.toString('utf8')
    : String(result.body || '');
  let finalContent = '';
  let upstreamReportedModel = '';
  let hasRefusal = false;
  let hasToolCall = false;
  let hasReasoning = false;
  let done = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const payload = parseJsonText(data);
    if (!payload) return invalid('malformed_sse', { finalContent, isStream: true });
    if (payload.error) {
      return invalid('wrapped_error', {
        upstreamReportedModel: modelName(payload),
        finalContent,
        isStream: true,
      });
    }
    upstreamReportedModel ||= modelName(payload);
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      const delta = choice?.delta || choice?.message || {};
      finalContent += contentToText(delta.content);
      hasRefusal ||= Boolean(contentToText(delta.refusal).trim());
      hasToolCall ||= Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
      hasReasoning ||= Boolean(contentToText(
        delta.reasoning_content ?? delta.reasoning ?? choice?.reasoning_content,
      ).trim());
    }
  }

  if (!done) {
    return invalid('incomplete_stream', { upstreamReportedModel, finalContent, isStream: true });
  }
  if (hasToolCall || hasRefusal) {
    return valid({ upstreamReportedModel, finalContent, isStream: true });
  }
  if (!finalContent.trim()) {
    return invalid(hasReasoning ? 'reasoning_only' : 'empty_content', {
      upstreamReportedModel,
      finalContent,
      isStream: true,
    });
  }
  if (requiresJsonContent(requestBody) && !parseJsonContent(finalContent)) {
    return invalid('invalid_json_content', {
      upstreamReportedModel,
      finalContent,
      isStream: true,
    });
  }
  return valid({ upstreamReportedModel, finalContent, isStream: true });
}

function isSse(result) {
  return String(result.headers?.['content-type'] || result.headers?.['Content-Type'] || '')
    .toLowerCase()
    .includes('text/event-stream');
}

function parseJsonBody(body) {
  return parseJsonText(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''));
}

function parseJsonText(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function parseJsonContent(text) {
  const direct = parseJsonText(text);
  if (direct) return direct;

  const trimmed = String(text || '').trim();
  const firstLineEnd = trimmed.indexOf('\n');
  if (firstLineEnd < 0 || !trimmed.endsWith('\n```')) return null;
  const openingFence = trimmed.slice(0, firstLineEnd).trim().toLowerCase();
  if (openingFence !== '```json' && openingFence !== '```') return null;

  const inner = trimmed.slice(firstLineEnd + 1, -4).trim();
  if (!inner || inner.includes('```')) return null;
  return parseJsonText(inner);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function requiresJsonContent(requestBody) {
  const type = requestBody?.response_format?.type;
  return type === 'json_object' || type === 'json_schema';
}

function modelName(payload) {
  return typeof payload?.model === 'string' ? payload.model : '';
}

function valid(extra = {}) {
  return { valid: true, failureClass: '', upstreamReportedModel: '', finalContent: '', isStream: false, ...extra };
}

function invalid(failureClass, extra = {}) {
  return { valid: false, failureClass, upstreamReportedModel: '', finalContent: '', isStream: false, ...extra };
}
