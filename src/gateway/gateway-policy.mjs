import { parseDuration, parseInteger, parseSize } from '../config/config-values.mjs';

const ENDPOINT_SUFFIXES = Object.freeze({
  openai: Object.freeze(['/chat/completions']),
  anthropic: Object.freeze(['/messages', '/v1/messages']),
  openai_responses: Object.freeze(['/responses']),
});

const KNOWN_ENDPOINT_SUFFIXES = Object.freeze(
  [...new Set(Object.values(ENDPOINT_SUFFIXES).flat())]
    .sort((left, right) => right.length - left.length),
);

export function gatewayLimitsFromEnv(env = process.env) {
  const requestTimeoutMs = parseDuration(
    env.TOMATO_TAP_SERVER_REQUEST_TIMEOUT || '2m',
    'TOMATO_TAP_SERVER_REQUEST_TIMEOUT',
  );
  const headersTimeoutMs = parseDuration(
    env.TOMATO_TAP_SERVER_HEADERS_TIMEOUT || '30s',
    'TOMATO_TAP_SERVER_HEADERS_TIMEOUT',
  );
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error('TOMATO_TAP_SERVER_HEADERS_TIMEOUT must not exceed TOMATO_TAP_SERVER_REQUEST_TIMEOUT');
  }
  return Object.freeze({
    maxRequestBytes: parseSize(
      env.TOMATO_TAP_MAX_REQUEST_SIZE || '32MiB',
      'TOMATO_TAP_MAX_REQUEST_SIZE',
    ),
    maxResponseBytes: parseSize(
      env.TOMATO_TAP_MAX_RESPONSE_SIZE || '32MiB',
      'TOMATO_TAP_MAX_RESPONSE_SIZE',
    ),
    ordinaryFirstByteTimeoutMs: parseDuration(
      env.TOMATO_TAP_ORDINARY_FIRST_BYTE_TIMEOUT || '2m',
      'TOMATO_TAP_ORDINARY_FIRST_BYTE_TIMEOUT',
    ),
    ordinaryTotalTimeoutMs: parseDuration(
      env.TOMATO_TAP_ORDINARY_TOTAL_TIMEOUT || '10m',
      'TOMATO_TAP_ORDINARY_TOTAL_TIMEOUT',
    ),
    serverRequestTimeoutMs: requestTimeoutMs,
    serverHeadersTimeoutMs: headersTimeoutMs,
    serverKeepAliveTimeoutMs: parseDuration(
      env.TOMATO_TAP_SERVER_KEEP_ALIVE_TIMEOUT || '5s',
      'TOMATO_TAP_SERVER_KEEP_ALIVE_TIMEOUT',
    ),
    shutdownGraceTimeoutMs: parseDuration(
      env.TOMATO_TAP_SHUTDOWN_GRACE_TIMEOUT || '150s',
      'TOMATO_TAP_SHUTDOWN_GRACE_TIMEOUT',
    ),
    serverMaxRequestsPerSocket: parseInteger(
      env.TOMATO_TAP_SERVER_MAX_REQUESTS_PER_SOCKET,
      'TOMATO_TAP_SERVER_MAX_REQUESTS_PER_SOCKET',
      { defaultValue: 1_000, min: 1, max: 1_000_000 },
    ),
  });
}

// Local control-plane requests are handled before route validation.
export function evaluateRouteRequest(route, method, pathname) {
  const normalizedPath = stripTrailingSlash(pathname);
  const allowedPaths = callPathsForRoute(route);
  if (!allowedPaths.includes(normalizedPath)) {
    return Object.freeze({
      allowed: false,
      status: 404,
      message: `tomato-tap: endpoint is not enabled for route ${route.prefix}`,
    });
  }
  if (String(method || '').toUpperCase() !== 'POST') {
    return Object.freeze({
      allowed: false,
      status: 405,
      allow: 'POST',
      message: 'tomato-tap: model endpoints require POST',
    });
  }
  return Object.freeze({ allowed: true });
}

export function callPathsForRoute(route) {
  const prefix = stripTrailingSlash(route?.prefix || '');
  if (!prefix) return [];
  if (KNOWN_ENDPOINT_SUFFIXES.some((suffix) => prefix.endsWith(suffix))) {
    return [prefix];
  }
  const format = route?.format || route?.apiFormat || 'openai';
  const suffixes = ENDPOINT_SUFFIXES[format] || [];
  return suffixes.map((suffix) => `${prefix}${suffix}`);
}

function stripTrailingSlash(value) {
  const normalized = String(value || '');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}
