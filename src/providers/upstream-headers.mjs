const SDK_HEADER_PREFIXES = Object.freeze(['x-stainless-', 'x-anthropic-', 'x-openai-']);
const HOP_BY_HOP_OR_REBUILT = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'originator',
  'accept',
  'openai-beta',
  'chatgpt-account-id',
]);

export function createUpstreamHeaderPolicy({
  defaultUserAgent = '',
  anthropicVersion = '2023-06-01',
  codexUserAgent = 'codex_cli_rs/0.125.0',
} = {}) {
  return function buildUpstreamHeaders(
    incoming,
    format,
    vendor,
    host,
    key,
    options = {},
  ) {
    const configuredUserAgent = headerValue(key?.headers, 'user-agent');
    const adapterForcesUserAgent = format === 'openai_responses'
      || vendor === 'claude_oauth';
    // A deployment without an explicit User-Agent is a transparent bridge.
    // Adapter profiles are the only exception because their upstream protocol
    // requires a stable client identity.
    const preserveUserAgent = !configuredUserAgent && !adapterForcesUserAgent;
    const headers = {};

    for (const [name, value] of Object.entries(incoming || {})) {
      const normalized = name.toLowerCase();
      if (normalized.startsWith('x-mimo-') || normalized.startsWith('x-tomato-tap-')) continue;
      if (HOP_BY_HOP_OR_REBUILT.has(normalized)) continue;
      if (!preserveUserAgent && normalized === 'user-agent') continue;
      if (SDK_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;
      headers[name] = value;
    }

    headers.Host = host;
    if (options.preserveIncomingHeaders !== true
      && options.preserveIncomingUserAgent !== true) {
      headers['Accept-Encoding'] = 'identity';
    }
    if (!hasHeader(headers, 'user-agent') && String(defaultUserAgent || '').trim()) {
      headers['User-Agent'] = String(defaultUserAgent).trim();
    }

    // Xiaomi Mimo's OpenAI-compatible endpoint expects the supported OpenCode
    // client profile. A deployment can still override this header explicitly.
    if (vendor === 'mimo' && format === 'openai') headers.originator = 'opencode';
    for (const [name, value] of Object.entries(key?.headers || {})) headers[name] = value;

    if (format === 'anthropic' && !hasHeader(headers, 'anthropic-version')) {
      headers['anthropic-version'] = anthropicVersion;
    }

    if (format === 'openai_responses') {
      headers['User-Agent'] = codexUserAgent;
      headers.originator = 'codex_cli_rs';
      headers.Accept = 'text/event-stream';
      headers['openai-beta'] = 'responses=experimental';
      if (key?.chatgptAccountId) headers['chatgpt-account-id'] = key.chatgptAccountId;
    }

    if (vendor === 'claude_oauth') {
      headers['User-Agent'] = codexUserAgent;
    }
    return headers;
  };
}

function hasHeader(headers, expected) {
  return Object.keys(headers).some((name) => name.toLowerCase() === expected);
}

function headerValue(headers, expected) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === expected && String(value || '').trim()) return String(value);
  }
  return '';
}
