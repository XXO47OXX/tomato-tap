import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRequestBody, RequestBodyError } from '../gateway/request-reader.mjs';
import { discoverProviderModels } from './provider-model-discovery.mjs';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'web');
const STATIC_FILES = Object.freeze({
  '/admin/assets/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/admin/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/route-state.js': ['route-state.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/api.js': ['api.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/views.js': ['views.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/view-data.js': ['view-data.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/cost-format.js': ['cost-format.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/workbenches.js': ['workbenches.js', 'text/javascript; charset=utf-8'],
  '/admin/assets/model-picker.js': ['model-picker.js', 'text/javascript; charset=utf-8'],
});

export function createAdminConsole({
  configStore,
  getStatusPayload,
  getPhysicalModels,
  getLogicalModels,
  getUsageToday,
  reloadRuntime,
  discoverModels = discoverProviderModels,
  bindHost = '127.0.0.1',
  adminToken = '',
  detailLevel = 'safe',
  logger = console,
} = {}) {
  if (!configStore?.snapshot) throw new Error('admin console requires configStore');
  if (typeof getStatusPayload !== 'function') throw new Error('admin console requires status');
  const index = readFileSync(join(WEB_ROOT, 'index.html'));
  const assets = new Map(Object.entries(STATIC_FILES).map(([path, [file, contentType]]) => [
    path,
    { body: readFileSync(join(WEB_ROOT, file)), contentType },
  ]));
  const token = String(adminToken || '');
  const remotelyBound = !isLoopbackHost(bindHost);
  const adminDetailLevel = normalizeDetailLevel(detailLevel);

  async function handle(request, response, { pathname, parsedUrl }) {
    if (pathname === '/') {
      if (request.method !== 'GET') return false;
      response.writeHead(302, { location: '/admin/' });
      response.end();
      return true;
    }

    if (assets.has(pathname)) {
      if (request.method !== 'GET') return methodNotAllowed(response, ['GET']);
      const asset = assets.get(pathname);
      sendStatic(response, 200, asset.body, asset.contentType, { cache: true });
      return true;
    }

    if (pathname === '/admin' || pathname === '/admin/' || isSpaPath(pathname)) {
      if (request.method !== 'GET') return methodNotAllowed(response, ['GET']);
      sendStatic(response, 200, index, 'text/html; charset=utf-8');
      return true;
    }

    if (!pathname.startsWith('/admin/api/')) return false;
    if (!authorize(request, response, { token, remotelyBound })) return true;

    try {
      if (pathname === '/admin/api/bootstrap' && request.method === 'GET') {
        sendJson(response, 200, bootstrapPayload());
        return true;
      }
      if (pathname === '/admin/api/export' && request.method === 'GET') {
        sendJson(response, 200, {
          object: 'tomato_tap.redacted_export',
          exported_at: new Date().toISOString(),
          configuration: configStore.snapshot(),
        });
        return true;
      }
      if (pathname === '/admin/api/providers' && request.method === 'POST') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.upsertProvider(body));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.provider', configuration, runtime });
        return true;
      }
      if (pathname === '/admin/api/providers/discover-models' && request.method === 'POST') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        if (typeof configStore.providerDiscoveryTarget !== 'function') {
          throw new AdminInputError('provider model discovery is unavailable', 501);
        }
        const target = mutateConfig(() => configStore.providerDiscoveryTarget(body));
        try {
          sendJson(response, 200, await discoverModels(target));
        } catch (error) {
          throw new AdminInputError(sanitizeError(error), 502);
        }
        return true;
      }
      const providerMatch = pathname.match(/^\/admin\/api\/providers\/([^/]+)$/);
      if (providerMatch && request.method === 'PATCH') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.setProviderEnabled(
          decodeURIComponent(providerMatch[1]),
          body.enabled,
        ));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.provider', configuration, runtime });
        return true;
      }
      if (providerMatch && request.method === 'DELETE') {
        requireMutationHeaders(request);
        const body = await readJson(request, { allowEmpty: true });
        const id = decodeURIComponent(providerMatch[1]);
        if (body.confirm !== id) throw new AdminInputError('type the provider ID to confirm removal');
        const configuration = mutateConfig(() => configStore.removeProvider(id, {
          clearCredential: body.clearCredential !== false,
        }));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.provider_removed', configuration, runtime });
        return true;
      }
      if (pathname === '/admin/api/logical-models' && request.method === 'POST') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.upsertLogicalModel(body));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.logical_model', configuration, runtime });
        return true;
      }
      if (pathname === '/admin/api/real-models' && request.method === 'POST') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.upsertRealModel(body));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.real_model', configuration, runtime });
        return true;
      }
      const logicalMatch = pathname.match(/^\/admin\/api\/logical-models\/([^/]+)$/);
      if (logicalMatch && request.method === 'DELETE') {
        requireMutationHeaders(request);
        const body = await readJson(request, { allowEmpty: true });
        const name = decodeURIComponent(logicalMatch[1]);
        if (body.confirm !== name) throw new AdminInputError('type the logical model name to confirm removal');
        const configuration = mutateConfig(() => configStore.removeLogicalModel(name));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, { object: 'tomato_tap.logical_model_removed', configuration, runtime });
        return true;
      }
      if (pathname === '/admin/api/settings' && request.method === 'PUT') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.updateSettings(body));
        sendJson(response, 200, {
          object: 'tomato_tap.settings',
          configuration,
          restart_required: true,
        });
        return true;
      }
      if (pathname === '/admin/api/egress' && request.method === 'PUT') {
        requireMutationHeaders(request);
        const body = await readJson(request);
        const configuration = mutateConfig(() => configStore.updateEgress(body));
        const runtime = await reloadRuntime?.();
        sendJson(response, 200, {
          object: 'tomato_tap.egress',
          configuration,
          runtime,
          restart_required: Boolean(body.sharedProxyUrl || body.clearSharedProxy),
        });
        return true;
      }
      if (pathname === '/admin/api/reload' && request.method === 'POST') {
        requireMutationHeaders(request);
        await readJson(request, { allowEmpty: true });
        sendJson(response, 200, {
          object: 'tomato_tap.reload',
          runtime: await reloadRuntime?.(),
        });
        return true;
      }
      methodNotAllowed(response, allowedMethodsFor(pathname));
      return true;
    } catch (error) {
      const status = error instanceof AdminInputError || error instanceof RequestBodyError
        ? error.status || 400
        : 500;
      const message = sanitizeError(error);
      if (status >= 500) logger.error?.(`[admin] ${message}`);
      sendJson(response, status, {
        error: {
          type: status >= 500 ? 'admin_internal_error' : 'invalid_admin_request',
          message,
        },
      });
      return true;
    }
  }

  function bootstrapPayload() {
    return {
      object: 'tomato_tap.admin_bootstrap',
      generated_at: new Date().toISOString(),
      access: {
        loopback_only: !remotelyBound,
        token_required: token.length > 0,
        detail_level: adminDetailLevel,
      },
      configuration: configStore.snapshot(),
      status: sanitizeAdminStatus(getStatusPayload(), adminDetailLevel),
      models: {
        physical: getPhysicalModels?.() || [],
        logical: getLogicalModels?.() || [],
      },
      usage_today: getUsageToday?.() || null,
    };
  }

  return Object.freeze({ handle });
}

export function sanitizeAdminStatus(status, detailLevel = 'safe') {
  const level = normalizeDetailLevel(detailLevel);
  const source = status && typeof status === 'object' ? status : {};
  const keys = Array.isArray(source.key_pool) ? source.key_pool : [];
  const slotByName = new Map();
  const keyPool = keys.map((key, index) => {
    const slotId = `key-${String(index + 1).padStart(3, '0')}`;
    const name = String(key?.name || '');
    if (name) slotByName.set(name, slotId);
    const safeKey = { ...key, slot_id: slotId };
    if (level === 'safe') {
      delete safeKey.name;
      delete safeKey.host;
    }
    return safeKey;
  });
  const quotaEvents = (Array.isArray(source.quota_infer_events) ? source.quota_infer_events : [])
    .map((event) => {
      const safeEvent = {
        ...event,
        slot_id: slotByName.get(String(event?.key || '')) || '',
      };
      if (level === 'safe') delete safeEvent.key;
      if (level !== 'debug') delete safeEvent.body_snippet;
      return safeEvent;
    });
  return {
    ...source,
    key_pool: keyPool,
    quota_infer_events: quotaEvents,
    admin_detail_level: level,
  };
}

function normalizeDetailLevel(value) {
  const level = String(value || 'safe').trim().toLowerCase();
  return ['safe', 'operator', 'debug'].includes(level) ? level : 'safe';
}

function authorize(request, response, { token, remotelyBound }) {
  if (remotelyBound && !token) {
    sendJson(response, 403, {
      error: {
        type: 'admin_disabled',
        message: 'admin API is disabled beyond loopback until TOMATO_TAP_ADMIN_TOKEN is configured',
      },
    });
    return false;
  }
  if (!token) return true;
  const authorization = String(request.headers.authorization || '');
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!constantTimeEqual(supplied, token)) {
    sendJson(response, 401, {
      error: { type: 'admin_auth_required', message: 'valid admin token required' },
    }, { 'www-authenticate': 'Bearer realm="Tomato Tap admin"' });
    return false;
  }
  return true;
}

function requireMutationHeaders(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.includes('application/json')) {
    throw new AdminInputError('admin mutations require application/json');
  }
  if (request.headers['x-tomato-tap-admin'] !== 'console') {
    throw new AdminInputError('admin mutation header is missing', 403);
  }
  const origin = String(request.headers.origin || '');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* rejected below */ }
    if (!host || host !== request.headers.host) {
      throw new AdminInputError('cross-origin admin mutation rejected', 403);
    }
  }
}

async function readJson(request, { allowEmpty = false } = {}) {
  const buffer = await readRequestBody(request, { maxBytes: 1024 * 1024 });
  if (buffer.length === 0 && allowEmpty) return {};
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('object required');
    }
    return parsed;
  } catch {
    throw new AdminInputError('request body must be a JSON object');
  }
}

function mutateConfig(operation) {
  try {
    return operation();
  } catch (error) {
    // Filesystem and malformed-on-disk failures are operator/server problems;
    // schema and value validation failures are safe 400 responses.
    if (error?.code || error instanceof SyntaxError) throw error;
    throw new AdminInputError(sanitizeError(error));
  }
}

function sendStatic(response, status, body, contentType, { cache = false } = {}) {
  response.writeHead(status, securityHeaders({
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': cache ? 'no-cache' : 'no-store',
  }));
  response.end(body);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  }));
  response.end(body);
}

function securityHeaders(headers) {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...headers,
  };
}

function methodNotAllowed(response, methods) {
  sendJson(response, 405, {
    error: { type: 'method_not_allowed', message: `${methods.join(' or ')} required` },
  }, { allow: methods.join(', ') });
  return true;
}

function allowedMethodsFor(pathname) {
  if (pathname.endsWith('/providers/discover-models')) return ['POST'];
  if (pathname.endsWith('/real-models')) return ['POST'];
  if (pathname.endsWith('/egress')) return ['PUT'];
  if (/\/providers\/[^/]+$/.test(pathname)) return ['PATCH', 'DELETE'];
  if (/\/logical-models\/[^/]+$/.test(pathname)) return ['DELETE'];
  return ['GET'];
}

function isSpaPath(pathname) {
  return /^\/admin\/(overview|providers|connections|models|egress|runtime|diagnostics|usage|settings|setup)\/?$/.test(pathname);
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').toLowerCase());
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sanitizeError(error) {
  return String(error?.message || error || 'admin request failed')
    .replace(/(?:sk|tp|ark|ak|nvapi|cwk)[_-][A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 512);
}

class AdminInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
