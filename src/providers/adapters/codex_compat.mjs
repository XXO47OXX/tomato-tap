// codex_compat.mjs — protocol adapter for ChatGPT Team OAuth tokens.
//
// Translates between the OpenAI Chat Completions API and the Codex Responses
// API exposed by
//   POST https://chatgpt.com/backend-api/codex/responses
//
// Supported scope:
//   - system / user / assistant TEXT messages only
//   - NO tools, NO function_call, NO multimodal images, NO reasoning_effort
//   - upstream MUST be stream=true + store=false (Codex backend rejects otherwise)
//   - we accumulate SSE deltas, then return a single non-streaming
//     chat.completion JSON to a non-streaming client
//   - Codex models recognised: gpt-5.4 (default), gpt-5.4-mini, gpt-5.5
//     (any other model name falls through to "gpt-5.4")
//
// Header injection is the upstream-header policy's responsibility —
// this module only deals with request body / SSE body transforms.

import crypto from 'node:crypto';

const DEFAULT_INSTRUCTIONS = 'You are ChatGPT, a helpful assistant.';
const ALLOWED_MODELS = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']);
const DEFAULT_MODEL = 'gpt-5.4';

// Client-side aliases map stable deployment names to accepted upstream models.
//
// Alias is one-way: upstream sends the mapped model, but the response
// returned to the client preserves the ORIGINAL alias as response.model.
// Preserving the requested alias keeps downstream attribution stable. See
// codexSSEToChatCompletion: response.model = requestedModel (alias-preserving).
const MODEL_ALIASES = new Map([
  ['gpt-5.4-codex',      'gpt-5.4'],
  ['gpt-5.4-mini-codex', 'gpt-5.4-mini'],
  ['gpt-5.5-codex',      'gpt-5.5'],
]);

// ============================================================================
// Request transform (chat → codex)
// ============================================================================

// Convert an OpenAI Chat Completions request body (Buffer or object) into the
// Codex Responses request body (object). Returns null if the input is invalid.
export function chatCompletionsToCodexRequest(reqBody) {
  const chat = bufferToObject(reqBody);
  if (!chat || !Array.isArray(chat.messages)) return null;

  const messages = chat.messages;

  // Pull the first system message into `instructions`; subsequent system
  // messages are concatenated into instructions as well (with newlines). The
  // remaining non-system messages become Responses input items.
  const systemBlocks = [];
  const inputItems = [];
  for (const m of messages) {
    if (!m || typeof m.role !== 'string') continue;
    if (m.role === 'system') {
      const t = extractMessageText(m.content);
      if (t) systemBlocks.push(t);
      continue;
    }
    const item = chatMessageToResponsesItem(m);
    if (item) inputItems.push(item);
  }

  // Ensure we have at least one user-side input; Codex rejects empty input.
  if (inputItems.length === 0) {
    inputItems.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: ' ' }],
    });
  }

  const instructions = systemBlocks.length > 0
    ? systemBlocks.join('\n\n')
    : DEFAULT_INSTRUCTIONS;

  const model = mapModelToCodex(chat.model);

  const out = {
    model,
    instructions,
    input: inputItems,
    store: false,
    stream: true,
  };

  // Account-backed Responses endpoints commonly enforce a strict request
  // allowlist. Keep only the protocol fields required by this adapter.

  return out;
}

function chatMessageToResponsesItem(m) {
  const text = extractMessageText(m.content);
  if (m.role === 'assistant') {
    // Assistant content uses output_text (already produced by the model).
    if (!text) return null;
    return {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    };
  }
  // user / tool / function / unknown roles → treat as user input_text.
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: text || ' ' }],
  };
}

// Chat Completions content can be either a plain string or an array of typed
// parts (text / image_url / ...). MVP flattens to text-only and drops images.
function extractMessageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string') {
      out.push(p.text);
    }
    // image_url and other types are silently dropped (MVP).
  }
  return out.join('');
}

function mapModelToCodex(name) {
  if (typeof name !== 'string') return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(name)) return name;
  const alias = MODEL_ALIASES.get(name);
  if (alias) return alias;
  // Unknown — fall through to default.
  return DEFAULT_MODEL;
}

// ============================================================================
// Response transform (codex SSE → chat completion JSON)
// ============================================================================

// Parse a buffered SSE stream from /backend-api/codex/responses into a single
// non-streaming Chat Completions response object.
//
// Returns:
//   { ok: true, response: <chat.completion object> }    on success
//   { ok: false, status: <int>, error: <obj> }          when the upstream
//                                                       stream conveyed an error
export function codexSSEToChatCompletion(sseBuf, requestedModel) {
  const text = bufToString(sseBuf);
  const events = parseSSEEvents(text);

  // Accumulators
  let textBuf = '';
  let reasoningBuf = '';
  let respId = '';
  let modelFromUpstream = '';
  let usage = null;
  let finalStatus = 'completed';
  let incompleteReason = '';
  let errorPayload = null;
  let sawAnyDelta = false;

  for (const ev of events) {
    const evType = ev.event || (ev.data && ev.data.type) || '';
    const d = ev.data || {};

    switch (evType) {
      case 'response.created':
        if (d.response) {
          if (d.response.id)    respId = d.response.id;
          if (d.response.model) modelFromUpstream = d.response.model;
        }
        break;
      case 'response.output_text.delta':
        if (typeof d.delta === 'string') {
          textBuf += d.delta;
          sawAnyDelta = true;
        }
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof d.delta === 'string') {
          reasoningBuf += d.delta;
          sawAnyDelta = true;
        }
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        if (d.response) {
          if (d.response.usage) usage = d.response.usage;
          if (d.response.status) finalStatus = d.response.status;
          if (d.response.incomplete_details && d.response.incomplete_details.reason) {
            incompleteReason = d.response.incomplete_details.reason;
          }
          // If terminal event carries an empty output array but accumulated
          // text/reasoning, we still surface the accumulated content.
          if (Array.isArray(d.response.output) && d.response.output.length > 0 && !sawAnyDelta) {
            for (const item of d.response.output) {
              if (!item) continue;
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const p of item.content) {
                  if (p && p.type === 'output_text' && typeof p.text === 'string') textBuf += p.text;
                }
              } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
                for (const s of item.summary) {
                  if (s && s.type === 'summary_text' && typeof s.text === 'string') reasoningBuf += s.text;
                }
              }
            }
          }
        }
        if (evType === 'response.failed') {
          errorPayload = (d.response && d.response.error) || d.error || { message: 'response.failed' };
        }
        break;
      default:
        // Other event types (output_item.added, web_search_call, ...) are
        // not needed for MVP text-only output.
        break;
    }
  }

  if (errorPayload) {
    return { ok: false, status: 502, error: errorPayload };
  }

  const finishReason = finishReasonFor(finalStatus, incompleteReason);
  const chatModel = requestedModel || modelFromUpstream || DEFAULT_MODEL;

  const message = { role: 'assistant', content: textBuf };
  if (reasoningBuf) message.reasoning_content = reasoningBuf;

  const response = {
    id: respId || generateChatCmplID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: chatModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };

  if (usage) {
    response.usage = {
      prompt_tokens:     Number(usage.input_tokens)  || 0,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens:      (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
    };
    if (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) {
      response.usage.prompt_tokens_details = {
        cached_tokens: Number(usage.input_tokens_details.cached_tokens) || 0,
      };
    }
  }

  return { ok: true, response };
}

function finishReasonFor(status, incompleteReason) {
  if (status === 'incomplete' && incompleteReason === 'max_output_tokens') return 'length';
  if (status === 'failed') return 'stop';  // surfaced as error elsewhere
  return 'stop';
}

// ============================================================================
// SSE parsing helpers
// ============================================================================

// Parse an SSE byte buffer into an array of { event, data } records, where
// `data` is the JSON-decoded payload (or raw string if not JSON).
//
// Spec subset we care about:
//   event: <type>\n      (optional; falls back to data.type)
//   data: <payload>\n    (one per event for our upstream)
//   <blank line>         (event separator)
function parseSSEEvents(text) {
  if (!text) return [];
  const events = [];
  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let evt = '';
    const dataParts = [];
    for (const lineRaw of block.split('\n')) {
      const line = lineRaw.replace(/\r$/, '');
      if (!line) continue;
      if (line.startsWith(':')) continue;  // SSE comment
      if (line.startsWith('event:')) {
        evt = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataParts.push(line.slice(5).trim());
      }
    }
    if (dataParts.length === 0) continue;
    const raw = dataParts.join('\n');
    if (raw === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Don't silently drop: a malformed event means lost content (delta
      // text or terminal usage stats). Throttled warn: 1st, 2nd, 4th, 8th
      // ... (log-spaced) prevents spam if upstream schema changes
      // wholesale, while still surfacing the first few occurrences quickly.
      warnSSEParseFailureThrottled(evt, raw);
      continue;
    }
    if (parsed !== null) events.push({ event: evt, data: parsed });
  }
  return events;
}

// In-module counter for SSE parse failures. Exported via getter for tests.
let _sseParseFailCount = 0;
function warnSSEParseFailureThrottled(evt, raw) {
  _sseParseFailCount++;
  const n = _sseParseFailCount;
  // Log-spaced: 1, 2, 4, 8, 16, 32, ... cuts noise by 10x at 1k errors
  // while making 1st/2nd/4th visible. Power-of-2 check via popcount.
  if ((n & (n - 1)) !== 0) return;
  console.warn(`[codex-sse] failed to parse event #${n} (evt=${evt || '?'}, bytes=${raw.length}): ${raw.slice(0, 120)}`);
}
export function _sseParseFailCountForTest() { return _sseParseFailCount; }
export function _resetSSEParseFailCountForTest() { _sseParseFailCount = 0; }

// ============================================================================
// Misc helpers
// ============================================================================

function bufferToObject(x) {
  if (x == null) return null;
  if (Buffer.isBuffer(x)) {
    try { return JSON.parse(x.toString('utf8')); } catch { return null; }
  }
  if (typeof x === 'string') {
    try { return JSON.parse(x); } catch { return null; }
  }
  if (typeof x === 'object') return x;
  return null;
}

function bufToString(x) {
  if (x == null) return '';
  if (Buffer.isBuffer(x)) return x.toString('utf8');
  return String(x);
}

function generateChatCmplID() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}
