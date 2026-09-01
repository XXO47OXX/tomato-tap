import { chatCompletionsToCodexRequest, codexSSEToChatCompletion } from './adapters/codex_compat.mjs';
import { anthropicMessagesToOpenAIChat, openAIChatToAnthropicMessage } from './adapters/claude_oauth_compat.mjs';

export function authBearer(headers, key) {
  delete headers.authorization;
  delete headers.Authorization;
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];
  headers.Authorization = `Bearer ${key}`;
}

export function authXApiKey(headers, key) {
  delete headers.authorization;
  delete headers.Authorization;
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];
  headers['x-api-key'] = key;
}

export function applyRelayAuth(headers, key, authType, fallback = authBearer) {
  if (authType === 'x-api-key') return authXApiKey(headers, key);
  if (authType === 'bearer') return authBearer(headers, key);
  return fallback(headers, key);
}

export function createVendorFunctionRegistry() {
  return Object.freeze({
    auth: Object.freeze({ bearer: authBearer, 'x-api-key': authXApiKey }),
    inject: Object.freeze({
      injectReasoningSplit,
      injectChatToCodex,
      anthropicMessagesToOpenAIChat,
      disableThinking,
    }),
    transform: Object.freeze({
      transformCodexToChat,
      openAIChatToAnthropicMessage,
    }),
  });
}

export function injectReasoningSplit(reqBuf, headers) {
  const parsed = parseJsonBody(reqBuf, headers);
  if (!parsed) return reqBuf;
  if (!('reasoning_split' in parsed)) parsed.reasoning_split = true;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

export function disableThinking(reqBuf, headers) {
  const parsed = parseJsonBody(reqBuf, headers);
  if (!parsed) return reqBuf;
  parsed.chat_template_kwargs = { ...(parsed.chat_template_kwargs || {}), enable_thinking: false };
  parsed.thinking = { type: 'disabled' };
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

export function injectChatToCodex(reqBuf) {
  const codexBody = chatCompletionsToCodexRequest(reqBuf);
  return codexBody ? Buffer.from(JSON.stringify(codexBody), 'utf8') : reqBuf;
}

export function transformCodexToChat(result, requestedModel) {
  if (!result || result.networkError || result.status < 200 || result.status >= 300) return result;
  const parsed = codexSSEToChatCompletion(result.body, requestedModel);
  if (!parsed.ok) {
    return {
      status: 422,
      statusMessage: 'Unprocessable Entity',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        error: {
          type: 'codex_response_failed',
          message: 'upstream codex stream reported failure',
          upstream: parsed.error,
        },
      }), 'utf8'),
      networkError: null,
    };
  }
  return {
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(parsed.response), 'utf8'),
    networkError: null,
  };
}

function parseJsonBody(reqBuf, headers) {
  if (!reqBuf?.length) return null;
  const contentType = String(headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('json')) return null;
  try {
    const parsed = JSON.parse(reqBuf.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
