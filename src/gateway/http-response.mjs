// Response helpers shared by ordinary and logical routes.

export function rejectAnthropic(res, code, message, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type: 'mimo_tap_blocked', message } }));
}

export function rejectOpenAI(res, code, message, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { code: String(code), type: 'mimo_tap_blocked', message } }));
}

export function rejectByPath(res, urlPath, code, message, route, headers = {}) {
  const anthropic = route?.format === 'anthropic' || urlPath.startsWith('/anthropic');
  return anthropic
    ? rejectAnthropic(res, code, message, headers)
    : rejectOpenAI(res, code, message, headers);
}

// Replace hop-by-hop headers after buffering the upstream body.
export function deliverResponseToClient(clientRes, result, { logger = console } = {}) {
  const headers = {};
  const stripped = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  for (const [key, value] of Object.entries(result.headers || {})) {
    const lower = key.toLowerCase();
    if (stripped.has(lower)) continue;
    headers[key] = value;
  }
  headers['content-length'] = String(result.body.length);
  try {
    clientRes.writeHead(result.status || 502, headers);
    clientRes.end(result.body);
  } catch (error) {
    logger.error(`failed to write to client: ${error.message}`);
    try { clientRes.end(); } catch { /* already closed */ }
  }
}
