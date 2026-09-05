import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const JSON_RPC_VERSION = '2.0';
const DEFAULT_MODEL = 'cursor-agent';
const DEFAULT_COMMAND = 'cursor-agent';
const DEFAULT_ACP_ARGS = Object.freeze(['acp']);
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Local HTTP facade for Cursor's Agent Client Protocol (ACP).
//
// ACP is an agent protocol, not an OpenAI model protocol. This adapter keeps
// the boundary explicit: callers send an OpenAI Chat Completions request to a
// local endpoint, while the bridge starts one cursor-agent ACP session and
// returns only the agent's text message. Tool/file/terminal requests from the
// agent are rejected by default; this bridge is intentionally text-only.
export function createCursorAcpBridge({
  enabled = false,
  host = '127.0.0.1',
  port = 8891,
  command = DEFAULT_COMMAND,
  args = DEFAULT_ACP_ARGS,
  apiKey = '',
  cwd = process.cwd(),
  model = '',
  maxConcurrent = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  logger = console,
  clientName = 'tomato-tap',
  clientVersion = '0.1.0',
} = {}) {
  const normalized = normalizeOptions({
    enabled, host, port, command, args, apiKey, cwd, model,
    maxConcurrent, timeoutMs, maxBodyBytes, clientName, clientVersion,
  });
  let active = 0;
  let totalRequests = 0;
  let totalFailures = 0;
  let listening = false;
  let closing = false;

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      totalFailures += 1;
      logger.error?.(`[cursor-acp] request failed: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, {
        error: {
          type: 'cursor_acp_internal_error',
          message: 'Cursor ACP bridge failed internally',
        },
      });
      else if (!response.writableEnded) response.end();
    }
  });

  async function handleRequest(request, response) {
    const url = new URL(request.url || '/', `http://${normalized.host}:${normalized.port}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, snapshot());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, modelList());
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { type: 'not_found', message: 'Cursor ACP bridge route not found' } });
      return;
    }
    if (!normalized.enabled) {
      sendJson(response, 503, {
        error: { type: 'cursor_acp_disabled', message: 'Cursor ACP bridge is disabled' },
      });
      return;
    }
    if (!normalized.apiKey) {
      sendJson(response, 503, {
        error: { type: 'cursor_acp_not_configured', message: 'Cursor ACP API key is not configured' },
      });
      return;
    }
    if (closing) {
      sendJson(response, 503, {
        error: { type: 'cursor_acp_shutting_down', message: 'Cursor ACP bridge is shutting down' },
      });
      return;
    }
    if (active >= normalized.maxConcurrent) {
      sendJson(response, 503, {
        error: {
          type: 'cursor_acp_busy',
          message: `Cursor ACP bridge is at capacity (${active}/${normalized.maxConcurrent})`,
        },
      });
      return;
    }

    // Reserve before awaiting the body. Slow uploads must consume capacity,
    // otherwise several requests can all pass a maxConcurrent=1 check.
    active += 1;
    try {
      let body;
      try {
        body = await readJsonBody(request, normalized.maxBodyBytes);
      } catch (error) {
        sendJson(response, error.statusCode || 400, {
          error: { type: error.code || 'invalid_request', message: error.message },
        });
        return;
      }
      const validation = validateChatRequest(body);
      if (validation) {
        sendJson(response, 400, { error: { type: 'invalid_request_error', message: validation } });
        return;
      }
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        sendJson(response, 400, {
          error: {
            type: 'cursor_acp_tools_unsupported',
            message: 'Cursor ACP bridge is text-only; tools are disabled for this upstream',
          },
        });
        return;
      }

      totalRequests += 1;
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const prompt = buildCursorAcpPrompt(body.messages);
        const result = await runCursorAcpPrompt({
          command: normalized.command,
          args: normalized.args,
          apiKey: normalized.apiKey,
          cwd: normalized.cwd,
          // `cursor-agent` is the public Tomato-Tap model id, not a Cursor CLI
          // model id. Only pass --model when the operator explicitly configures
          // a real Cursor model name.
          model: normalized.model,
          prompt,
          timeoutMs: normalized.timeoutMs,
          signal: controller.signal,
          logger,
          clientName: normalized.clientName,
          clientVersion: normalized.clientVersion,
        });
        sendChatCompletion(response, result.text, body.model, body.stream === true);
      } catch (error) {
        totalFailures += 1;
        const status = error.statusCode || (error.code === 'ETIMEDOUT' ? 504 : 502);
        sendJson(response, status, {
          error: {
            type: error.type || 'cursor_acp_upstream_error',
            message: publicErrorMessage(error),
          },
        });
      } finally {
        request.off('aborted', abort);
      }
    } finally {
      active = Math.max(0, active - 1);
    }
  }

  function listen() {
    if (!normalized.enabled || listening) return Promise.resolve(address());
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        listening = true;
        resolve(address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(normalized.port, normalized.host);
    });
  }

  function close() {
    closing = true;
    if (!listening) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        listening = false;
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }

  function address() {
    const current = server.address();
    return typeof current === 'object' && current
      ? { host: current.address, port: current.port }
      : { host: normalized.host, port: normalized.port };
  }

  function snapshot() {
    return {
      enabled: normalized.enabled,
      listening,
      closing,
      address: address(),
      command: normalized.command,
      cwd: normalized.cwd,
      configured: Boolean(normalized.apiKey),
      model: normalized.model || DEFAULT_MODEL,
      max_concurrent: normalized.maxConcurrent,
      active,
      total_requests: totalRequests,
      total_failures: totalFailures,
      tools: 'disabled',
    };
  }

  return Object.freeze({
    listen,
    close,
    address,
    snapshot,
    enabled: normalized.enabled,
  });
}

export function buildCursorAcpPrompt(messages) {
  return messages.map((message) => {
    const role = String(message?.role || 'user').toLowerCase();
    const text = contentToText(message?.content);
    return `[${role}]\n${text}`;
  }).join('\n\n');
}

export function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'request body must be a JSON object';
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'request requires a non-empty messages[]';
  }
  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return `message at position ${index} must be an object`;
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      return `message at position ${index} has unsupported role`;
    }
    if (!contentToText(message.content).trim()) {
      return `message at position ${index} must not be empty`;
    }
  }
  if (typeof body.model !== 'string' || !body.model.trim()) return 'request requires model';
  return '';
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (part.type === 'image_url') return '[image input omitted by text-only ACP bridge]';
    return typeof part.text === 'string' ? part.text : '';
  }).join('\n');
}

export function toOpenAiResponse(text, requestedModel = DEFAULT_MODEL) {
  return {
    id: `chatcmpl-acp-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
  };
}

export function toOpenAiSse(text, requestedModel = DEFAULT_MODEL) {
  const id = `chatcmpl-acp-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = requestedModel || DEFAULT_MODEL;
  const chunk = (delta, finishReason = null) => JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  return [
    `data: ${chunk({ role: 'assistant' })}\n\n`,
    `data: ${chunk({ content: text })}\n\n`,
    `data: ${chunk({}, 'stop')}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

export function extractAcpText(message) {
  if (!message || message.method !== 'session/update') return '';
  const update = message.params?.update || message.params?.sessionUpdate || {};
  const kind = String(update.sessionUpdate || update.type || '').toLowerCase();
  if (!['agent_message_chunk', 'agent_message', 'message'].includes(kind)) return '';
  return extractContentText(update.content || update.message?.content || update);
}

export async function runCursorAcpPrompt({
  command = DEFAULT_COMMAND,
  args = DEFAULT_ACP_ARGS,
  apiKey,
  cwd = process.cwd(),
  model = '',
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  logger = console,
  clientName = 'tomato-tap',
  clientVersion = '0.1.0',
} = {}) {
  if (!apiKey) throw errorWith('Cursor ACP API key is not configured', 'cursor_acp_not_configured', 503);
  if (!prompt) throw errorWith('Cursor ACP prompt is empty', 'cursor_acp_empty_prompt', 400);
  const childArgs = buildCommandArgs(args, model);
  const child = spawn(command, childArgs, {
    cwd,
    env: { ...process.env, CURSOR_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const pending = new Map();
  const textChunks = [];
  let lineBuffer = '';
  let stderr = '';
  let settled = false;
  let nextId = 1;
  let timeoutHandle = null;
  let abortHandler = null;
  let killHandle = null;
  let childExited = false;

  const result = await new Promise((resolve, reject) => {
    const terminateChild = () => {
      if (childExited) return;
      try { child.kill('SIGTERM'); } catch { /* process already unavailable */ }
      if (killHandle) return;
      killHandle = setTimeout(() => {
        if (!childExited) {
          try { child.kill('SIGKILL'); } catch { /* process already unavailable */ }
        }
      }, 2_000);
      killHandle.unref?.();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
      for (const waiter of pending.values()) waiter.reject(error || new Error('ACP process closed'));
      pending.clear();
      if (error) reject(error);
      else resolve(value);
    };
    const requestRpc = (method, params) => {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });
      return new Promise((resolveRpc, rejectRpc) => {
        pending.set(id, { resolve: resolveRpc, reject: rejectRpc });
        try {
          child.stdin.write(`${payload}\n`);
        } catch (error) {
          pending.delete(id);
          rejectRpc(error);
        }
      });
    };
    const respondToAgentRequest = (message) => {
      if (message.id == null) return;
      const payload = {
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        error: {
          code: -32601,
          message: 'Tomato-Tap ACP bridge has file, terminal, and tool calls disabled',
        },
      };
      try { child.stdin.write(`${JSON.stringify(payload)}\n`); } catch { /* process is closing */ }
    };
    const handleMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.method === 'session/update') {
        const chunk = extractAcpText(message);
        if (chunk) textChunks.push(chunk);
        return;
      }
      if (message.method && message.id != null) {
        respondToAgentRequest(message);
        return;
      }
      if (message.id == null) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        const error = errorWith(
          message.error.message || 'Cursor ACP returned an error',
          'cursor_acp_protocol_error',
          502,
        );
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
    };
    const parseStdout = (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let newline;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (!line) continue;
        try { handleMessage(JSON.parse(line)); }
        catch { logger.warn?.('[cursor-acp] ignored non-JSON stdout line'); }
      }
    };
    child.stdout.on('data', parseStdout);
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096);
    });
    child.once('error', (error) => {
      const wrapped = errorWith(
        `unable to start Cursor ACP command: ${error.message}`,
        'cursor_acp_spawn_error',
        503,
      );
      finish(wrapped);
    });
    child.once('close', (code, signalName) => {
      childExited = true;
      if (killHandle) clearTimeout(killHandle);
      if (settled) return;
      const detail = stderr.trim() ? `: ${stderr.trim().slice(-512)}` : '';
      finish(errorWith(
        `Cursor ACP process exited before completing the request (code=${code ?? 'null'}, signal=${signalName || 'none'})${detail}`,
        'cursor_acp_process_exit',
        502,
      ));
    });
    timeoutHandle = setTimeout(() => {
      const error = errorWith('Cursor ACP request timed out', 'cursor_acp_timeout', 504);
      error.code = 'ETIMEDOUT';
      terminateChild();
      finish(error);
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timeoutHandle.unref?.();
    abortHandler = () => {
      const error = errorWith('Cursor ACP request was cancelled by the client', 'cursor_acp_cancelled', 499);
      error.code = 'ECANCELED';
      terminateChild();
      finish(error);
    };
    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    (async () => {
      try {
        await requestRpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: clientName, version: clientVersion },
        });
        const session = await requestRpc('session/new', { cwd, mcpServers: [] });
        const sessionId = session?.sessionId;
        if (!sessionId) throw errorWith('Cursor ACP did not return a session id', 'cursor_acp_protocol_error', 502);
        await requestRpc('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: prompt }],
        });
        const output = textChunks.join('');
        if (!output.trim()) throw errorWith('Cursor ACP returned no text response', 'cursor_acp_empty_response', 502);
        finish(null, { text: output });
        terminateChild();
      } catch (error) {
        terminateChild();
        finish(error);
      }
    })();
  });
  return result;
}

function buildCommandArgs(args, model) {
  const output = [...(Array.isArray(args) ? args : DEFAULT_ACP_ARGS).map(String)];
  if (model && !output.includes('--model') && !output.includes('-m')) {
    output.unshift(model);
    output.unshift('--model');
  }
  return output;
}

function modelList() {
  return {
    object: 'list',
    data: [{
      id: DEFAULT_MODEL,
      object: 'model',
      created: 0,
      owned_by: 'cursor-acp',
    }],
  };
}

function normalizeOptions(options) {
  const normalizedPort = Number(options.port);
  const normalizedMaxConcurrent = Number(options.maxConcurrent);
  const normalizedTimeout = Number(options.timeoutMs);
  const normalizedMaxBody = Number(options.maxBodyBytes);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('cursor-acp: port must be an integer from 1 to 65535');
  }
  if (!Number.isSafeInteger(normalizedMaxConcurrent) || normalizedMaxConcurrent < 1) {
    throw new Error('cursor-acp: maxConcurrent must be a positive integer');
  }
  if (!Number.isSafeInteger(normalizedTimeout) || normalizedTimeout < 1_000) {
    throw new Error('cursor-acp: timeoutMs must be at least 1000');
  }
  if (!Number.isSafeInteger(normalizedMaxBody) || normalizedMaxBody < 1) {
    throw new Error('cursor-acp: maxBodyBytes must be positive');
  }
  if (!String(options.command || '').trim()) throw new Error('cursor-acp: command is required');
  if (!String(options.cwd || '').trim()) throw new Error('cursor-acp: cwd is required');
  const host = normalizeLoopbackHost(options.host);
  return Object.freeze({
    enabled: options.enabled === true,
    host,
    port: normalizedPort,
    command: String(options.command),
    args: [...(Array.isArray(options.args) ? options.args : DEFAULT_ACP_ARGS)].map(String),
    apiKey: String(options.apiKey || '').trim(),
    cwd: String(options.cwd),
    model: String(options.model || '').trim(),
    maxConcurrent: normalizedMaxConcurrent,
    timeoutMs: normalizedTimeout,
    maxBodyBytes: normalizedMaxBody,
    clientName: String(options.clientName || 'tomato-tap'),
    clientVersion: String(options.clientVersion || '0.1.0'),
  });
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = errorWith(`request body exceeds ${maxBytes} bytes`, 'request_too_large', 413);
        request.destroy(error);
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', (error) => reject(error));
    request.once('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch {
        reject(errorWith('request body must be valid JSON', 'invalid_json', 400));
      }
    });
  });
}

function sendJson(response, status, body) {
  if (response.writableEnded || response.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    connection: 'close',
  });
  response.end(payload);
}

function sendChatCompletion(response, text, model, stream) {
  if (!stream) {
    sendJson(response, 200, toOpenAiResponse(text, model));
    return;
  }
  if (response.writableEnded || response.destroyed) return;
  const payload = toOpenAiSse(text, model);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  response.end(payload);
}

function normalizeLoopbackHost(value) {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  if (host === 'localhost') return '127.0.0.1';
  if (/^127(?:\.\d{1,3}){3}$/.test(host)
      && host.split('.').every((part) => Number(part) <= 255)) return host;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return '::1';
  throw new Error('cursor-acp: host must bind to a loopback address');
}

function extractContentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractContentText).join('');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'string') return value.value;
  return extractContentText(value.content);
}

function errorWith(message, type, statusCode) {
  const error = new Error(message);
  error.type = type;
  error.statusCode = statusCode;
  return error;
}

function publicErrorMessage(error) {
  if (error?.type === 'cursor_acp_process_exit') return 'Cursor ACP process did not complete the request';
  if (error?.type === 'cursor_acp_spawn_error') return 'Cursor CLI is not installed or could not be started';
  if (error?.type === 'cursor_acp_not_configured') return 'Cursor ACP API key is not configured';
  return String(error?.message || 'Cursor ACP upstream failed').slice(0, 512);
}

