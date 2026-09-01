import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);

export function parseProxySubscription(text) {
  const source = decodeSubscription(String(text || ''));
  const nodes = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const rawUri = rawLine.trim();
    if (!rawUri.startsWith('vless://')) continue;
    try {
      const url = new URL(rawUri);
      const uuid = decodeURIComponent(url.username || '').toLowerCase();
      const server = url.hostname.toLowerCase();
      const port = Number(url.port);
      const transport = String(url.searchParams.get('type') || 'tcp').toLowerCase();
      if (!UUID_RE.test(uuid) || !server || !Number.isInteger(port)
          || port < 1 || port > 65535 || !TRANSPORTS.has(transport)) continue;
      const sortedQuery = [...url.searchParams.entries()]
        .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
      // Node identity must be stable across subscription refreshes: some
      // providers rotate cosmetic params (fp / mode) on every fetch, which
      // would otherwise churn the node id and invalidate sticky bindings.
      // Only endpoint-identity fields participate in the hash.
      const identityQuery = sortedQuery.filter(
        ([key]) => !['fp', 'mode', 'spx'].includes(key),
      );
      const canonical = { protocol: 'vless', uuid, server, port, query: identityQuery };
      const id = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
      if (nodes.has(id)) continue;
      nodes.set(id, {
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
      });
    } catch {
      // Ignore malformed records; callers report only aggregate counts.
    }
  }
  return [...nodes.values()];
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
  if (!trimmed || trimmed.includes('vless://')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
    return decoded.includes('vless://') ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}
