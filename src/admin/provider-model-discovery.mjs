import { uniqueNames } from './config-input.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function discoverProviderModels(target, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('model discovery requires fetch');
  const url = new URL(target.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  url.search = '';
  url.hash = '';
  const headers = { accept: 'application/json' };
  if (target.apiKey) {
    if (target.auth === 'x-api-key') headers['x-api-key'] = target.apiKey;
    else headers.authorization = `Bearer ${target.apiKey}`;
  }
  if (target.apiFormat === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`upstream model discovery returned HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('upstream model list is too large');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('upstream model list is too large');
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('upstream /models did not return JSON'); }
  const models = uniqueNames(extractModelIds(payload));
  if (models.length === 0) throw new Error('upstream /models returned no model IDs');
  return {
    object: 'tomato_tap.model_discovery',
    source: 'upstream',
    models,
    count: models.length,
  };
}

export function extractModelIds(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows.map((row) => (typeof row === 'string' ? row : row?.id || row?.name))
    .filter((value) => typeof value === 'string' && value.trim());
}
