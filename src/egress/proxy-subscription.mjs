import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);
const VLESS_SCHEME = 'vless://';
const SHADOWSOCKS_SCHEME = 'ss://';
const SUPPORTED_SCHEMES = [VLESS_SCHEME, SHADOWSOCKS_SCHEME, 'socks5://', 'socks5h://'];

export function parseProxySubscription(text) {
  const input = String(text || '');
  const clashNodes = parseClashProxyYaml(input);
  if (clashNodes.length) return deduplicateNodes(clashNodes);
  const source = decodeSubscription(input);
  const nodes = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const rawUri = rawLine.trim();
    if (!SUPPORTED_SCHEMES.some((scheme) => rawUri.startsWith(scheme))) continue;
    try {
      const node = rawUri.startsWith(VLESS_SCHEME)
        ? parseVlessNode(rawUri)
        : rawUri.startsWith(SHADOWSOCKS_SCHEME)
          ? parseShadowsocksNode(rawUri)
          : parseSocksNode(rawUri);
      if (!node) continue;
      const { id } = node;
      if (nodes.has(id)) continue;
      nodes.set(id, node);
    } catch {
      // Ignore malformed records; callers report only aggregate counts.
    }
  }
  return [...nodes.values()];
}

function parseClashProxyYaml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const marker = lines.findIndex((line) => /^\s*proxies\s*:\s*(?:#.*)?$/.test(line));
  if (marker < 0) return [];
  const markerIndent = leadingSpaces(lines[marker]);
  const blocks = [];
  const inlineNodes = [];
  let current = null;
  let itemIndent = null;
  for (const line of lines.slice(marker + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = leadingSpaces(line);
    if (indent <= markerIndent) break;
    const inline = line.match(/^\s*-\s*(\{.*\})\s*$/);
    if (inline) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      const node = clashInlineNode(parseFlowMapping(inline[1]));
      if (node) inlineNodes.push(node);
      continue;
    }
    const item = line.match(/^(\s*)-\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (item && (itemIndent == null || indent === itemIndent)) {
      if (current) blocks.push(current);
      itemIndent = indent;
      current = [{ indent: indent + 2, key: item[2], value: item[3] }];
      continue;
    }
    if (!current) continue;
    const field = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (field) current.push({ indent, key: field[2], value: field[3] });
  }
  if (current) blocks.push(current);
  return [...inlineNodes, ...blocks.map(clashVlessNode).filter(Boolean)];
}

function clashInlineNode(record) {
  if (!record) return null;
  const type = String(record.type || '').toLowerCase();
  if (type === 'vless') return clashInlineVlessNode(record);
  if (type === 'ss') return clashInlineShadowsocksNode(record);
  return null;
}

function clashInlineVlessNode(record) {
  const server = String(record.server || '').trim();
  const uuid = String(record.uuid || '').trim();
  const port = Number(record.port);
  const transport = String(record.network || 'tcp').toLowerCase();
  if (!TRANSPORTS.has(transport)) return null;
  const reality = objectValue(record['reality-opts']);
  const ws = objectValue(record['ws-opts']);
  const wsHeaders = objectValue(ws.headers);
  const grpc = objectValue(record['grpc-opts']);
  const publicKey = String(reality['public-key'] || '').trim();
  const security = publicKey ? 'reality' : (record.tls === true ? 'tls' : 'none');
  let url;
  try {
    const host = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
    url = new URL(`${VLESS_SCHEME}${encodeURIComponent(uuid)}@${host}:${port}`);
  } catch {
    return null;
  }
  url.searchParams.set('type', transport);
  url.searchParams.set('security', security);
  setQuery(url, 'sni', record.servername || record.sni);
  setQuery(url, 'flow', record.flow);
  setQuery(url, 'fp', record['client-fingerprint'] || record.fingerprint);
  setQuery(url, 'pbk', publicKey);
  setQuery(url, 'sid', reality['short-id']);
  if (transport === 'ws') {
    setQuery(url, 'path', ws.path);
    setQuery(url, 'host', wsHeaders.host);
  } else if (transport === 'grpc') {
    setQuery(url, 'serviceName', grpc['grpc-service-name'] || grpc['service-name']);
  }
  return parseVlessNode(url.toString());
}

function clashInlineShadowsocksNode(record) {
  const server = String(record.server || '').trim();
  const port = Number(record.port);
  const method = String(record.cipher || '').trim();
  const password = String(record.password || '');
  if (!method || !password) return null;
  const credentials = Buffer.from(`${method}:${password}`, 'utf8').toString('base64url');
  try {
    const host = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
    return parseShadowsocksNode(`${SHADOWSOCKS_SCHEME}${credentials}@${host}:${port}`);
  } catch {
    return null;
  }
}

function parseFlowMapping(raw) {
  const source = String(raw || '').trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return null;
  const output = {};
  for (const field of splitFlowFields(source.slice(1, -1))) {
    const separator = findFlowSeparator(field, ':');
    if (separator < 1) continue;
    const key = parseYamlScalar(field.slice(0, separator));
    const value = field.slice(separator + 1).trim();
    if (!key) continue;
    output[String(key).toLowerCase()] = value.startsWith('{') && value.endsWith('}')
      ? parseFlowMapping(value)
      : parseYamlScalar(value);
  }
  return output;
}

function splitFlowFields(source) {
  const fields = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = '';
      continue;
    }
    if (quote) continue;
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      fields.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  fields.push(source.slice(start).trim());
  return fields.filter(Boolean);
}

function findFlowSeparator(source, separator) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (!quote) quote = char;
      else if (quote === char) quote = '';
      continue;
    }
    if (quote) continue;
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === separator && depth === 0) return index;
  }
  return -1;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clashVlessNode(fields) {
  const itemIndent = Math.min(...fields.map((field) => field.indent));
  const top = new Map();
  const nested = new Map();
  let section = '';
  let subsection = '';
  for (const field of fields) {
    const key = field.key.toLowerCase();
    const value = parseYamlScalar(field.value);
    if (field.indent === itemIndent) {
      top.set(key, value);
      section = field.value.trim() ? '' : key;
      subsection = '';
    } else if (field.indent === itemIndent + 2 && section) {
      nested.set(`${section}.${key}`, value);
      subsection = field.value.trim() ? '' : key;
    } else if (field.indent > itemIndent + 2 && section && subsection) {
      nested.set(`${section}.${subsection}.${key}`, value);
    }
  }
  if (String(top.get('type') || '').toLowerCase() !== 'vless') return null;
  const server = String(top.get('server') || '').trim();
  const uuid = String(top.get('uuid') || '').trim();
  const port = Number(top.get('port'));
  const transport = String(top.get('network') || 'tcp').toLowerCase();
  if (!TRANSPORTS.has(transport)) return null;
  const publicKey = String(nested.get('reality-opts.public-key') || '').trim();
  const security = publicKey ? 'reality' : (top.get('tls') === true ? 'tls' : 'none');
  let url;
  try {
    const host = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
    url = new URL(`${VLESS_SCHEME}${encodeURIComponent(uuid)}@${host}:${port}`);
  } catch {
    return null;
  }
  url.searchParams.set('type', transport);
  url.searchParams.set('security', security);
  setQuery(url, 'sni', top.get('servername') || top.get('sni'));
  setQuery(url, 'flow', top.get('flow'));
  setQuery(url, 'fp', top.get('client-fingerprint') || top.get('fingerprint'));
  setQuery(url, 'pbk', publicKey);
  setQuery(url, 'sid', nested.get('reality-opts.short-id'));
  if (transport === 'ws') {
    setQuery(url, 'path', nested.get('ws-opts.path'));
    setQuery(url, 'host', nested.get('ws-opts.headers.host'));
  } else if (transport === 'grpc') {
    setQuery(
      url,
      'serviceName',
      nested.get('grpc-opts.grpc-service-name') || nested.get('grpc-opts.service-name'),
    );
  }
  return parseVlessNode(url.toString());
}

function parseYamlScalar(raw) {
  const value = String(raw || '').trim().replace(/\s+#.*$/, '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function setQuery(url, name, value) {
  if (value == null || String(value).trim() === '') return;
  url.searchParams.set(name, String(value));
}

function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

function deduplicateNodes(nodes) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

export function redactProxyNode(node) {
  return {
    id: String(node?.id || ''),
    protocol: String(node?.protocol || ''),
    serverHash: createHash('sha256').update(String(node?.server || '')).digest('hex').slice(0, 12),
    port: Number(node?.port || 0),
    transport: String(node?.transport || ''),
  };
}

function decodeSubscription(text) {
  const trimmed = text.trim();
  if (!trimmed || SUPPORTED_SCHEMES.some((scheme) => trimmed.includes(scheme))) return trimmed;
  try {
    const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
    return SUPPORTED_SCHEMES.some((scheme) => decoded.includes(scheme)) ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}

function parseVlessNode(rawUri) {
  const url = new URL(rawUri);
  const uuid = decodeURIComponent(url.username || '').toLowerCase();
  const server = url.hostname.toLowerCase();
  const port = Number(url.port);
  const transport = String(url.searchParams.get('type') || 'tcp').toLowerCase();
  if (!UUID_RE.test(uuid) || !validEndpoint(server, port) || !TRANSPORTS.has(transport)) return null;
  const sortedQuery = [...url.searchParams.entries()]
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  // Node identity must be stable across subscription refreshes: some
  // providers rotate cosmetic params (fp / mode) on every fetch, which
  // would otherwise churn the node id and invalidate sticky bindings.
  // Only endpoint-identity fields participate in the hash.
  const identityQuery = sortedQuery.filter(
    ([key]) => !['fp', 'mode', 'spx'].includes(key),
  );
  const id = nodeId({ protocol: 'vless', uuid, server, port, query: identityQuery });
  return {
    id,
    protocol: 'vless',
    server,
    port,
    uuid,
    transport,
    tls: {
      security: String(url.searchParams.get('security') || 'none').toLowerCase(),
      serverName: url.searchParams.get('sni') || '',
    },
    params: Object.fromEntries(sortedQuery),
  };
}

function parseShadowsocksNode(rawUri) {
  const withoutFragment = rawUri.split('#', 1)[0];
  let server;
  let port;
  let credentials;
  if (withoutFragment.slice(SHADOWSOCKS_SCHEME.length).includes('@')) {
    const url = new URL(withoutFragment);
    server = url.hostname.toLowerCase();
    port = Number(url.port);
    credentials = decodeBase64Url(decodeURIComponent(url.username || ''))
      || decodeURIComponent(url.username || '');
  } else {
    // Legacy Shadowsocks links base64-encode method:password@server:port as
    // one payload instead of encoding only method:password.
    const decoded = decodeBase64Url(withoutFragment.slice(SHADOWSOCKS_SCHEME.length).split('?', 1)[0]);
    const at = decoded.lastIndexOf('@');
    if (at < 1) return null;
    credentials = decoded.slice(0, at);
    const endpoint = new URL(`${SHADOWSOCKS_SCHEME}${decoded.slice(at + 1)}`);
    server = endpoint.hostname.toLowerCase();
    port = Number(endpoint.port);
  }
  const separator = credentials.indexOf(':');
  if (separator < 1 || !validEndpoint(server, port)) return null;
  const method = credentials.slice(0, separator).toLowerCase();
  const password = credentials.slice(separator + 1);
  if (!password) return null;
  const id = nodeId({ protocol: 'shadowsocks', method, password, server, port });
  return {
    id,
    protocol: 'shadowsocks',
    server,
    port,
    method,
    password,
    transport: 'tcp',
    tls: { security: 'none', serverName: '' },
    params: {},
  };
}

function parseSocksNode(rawUri) {
  const url = new URL(rawUri);
  const server = url.hostname.toLowerCase();
  const port = Number(url.port || 1080);
  if (!validEndpoint(server, port)) return null;
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  const id = nodeId({ protocol: 'socks5', server, port, username, password });
  return {
    id,
    protocol: 'socks5',
    server,
    port,
    username,
    password,
    transport: 'tcp',
    tls: { security: 'none', serverName: '' },
    params: {},
  };
}

function decodeBase64Url(value) {
  if (!value) return '';
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    return decoded.includes(':') ? decoded : '';
  } catch {
    return '';
  }
}

function validEndpoint(server, port) {
  return Boolean(server) && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function nodeId(canonical) {
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
