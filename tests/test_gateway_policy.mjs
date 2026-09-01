import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callPathsForRoute,
  evaluateRouteRequest,
  gatewayLimitsFromEnv,
} from '../src/gateway/gateway-policy.mjs';

test('route policy only forwards model calls on known endpoint paths', () => {
  const openai = { prefix: '/oa/v1', format: 'openai' };
  assert.deepEqual(callPathsForRoute(openai), ['/oa/v1/chat/completions']);
  assert.equal(evaluateRouteRequest(openai, 'POST', '/oa/v1/chat/completions').allowed, true);
  assert.equal(evaluateRouteRequest(openai, 'POST', '/oa/v1/files').status, 404);
  assert.deepEqual(evaluateRouteRequest(openai, 'GET', '/oa/v1/chat/completions'), {
    allowed: false,
    status: 405,
    allow: 'POST',
    message: 'tomato-tap: model endpoints require POST',
  });
});

test('route policy accepts exact endpoint prefixes and anthropic base variants', () => {
  const direct = { prefix: '/direct/v1/messages', format: 'anthropic' };
  assert.deepEqual(callPathsForRoute(direct), ['/direct/v1/messages']);
  assert.equal(evaluateRouteRequest(direct, 'post', '/direct/v1/messages/').allowed, true);

  const anthropic = { prefix: '/anthropic', format: 'anthropic' };
  assert.deepEqual(callPathsForRoute(anthropic), [
    '/anthropic/messages',
    '/anthropic/v1/messages',
  ]);
  assert.equal(evaluateRouteRequest(anthropic, 'POST', '/anthropic/v1/messages').allowed, true);
});

test('gateway limits are bounded, configurable, and reject contradictory timeouts', () => {
  const defaults = gatewayLimitsFromEnv({});
  assert.equal(defaults.maxRequestBytes, 32 * 1024 * 1024);
  assert.equal(defaults.maxResponseBytes, 32 * 1024 * 1024);
  assert.equal(defaults.ordinaryTotalTimeoutMs, 10 * 60 * 1000);
  assert.equal(defaults.shutdownGraceTimeoutMs, 150 * 1000);

  const custom = gatewayLimitsFromEnv({
    TOMATO_TAP_MAX_REQUEST_SIZE: '2MiB',
    TOMATO_TAP_MAX_RESPONSE_SIZE: '3MiB',
    TOMATO_TAP_ORDINARY_FIRST_BYTE_TIMEOUT: '45s',
    TOMATO_TAP_ORDINARY_TOTAL_TIMEOUT: '3m',
    TOMATO_TAP_SERVER_REQUEST_TIMEOUT: '90s',
    TOMATO_TAP_SERVER_HEADERS_TIMEOUT: '15s',
    TOMATO_TAP_SERVER_KEEP_ALIVE_TIMEOUT: '8s',
    TOMATO_TAP_SERVER_MAX_REQUESTS_PER_SOCKET: '25',
    TOMATO_TAP_SHUTDOWN_GRACE_TIMEOUT: '3m',
  });
  assert.equal(custom.maxRequestBytes, 2 * 1024 * 1024);
  assert.equal(custom.maxResponseBytes, 3 * 1024 * 1024);
  assert.equal(custom.serverMaxRequestsPerSocket, 25);
  assert.equal(custom.shutdownGraceTimeoutMs, 3 * 60 * 1000);
  assert.throws(() => gatewayLimitsFromEnv({
    TOMATO_TAP_SERVER_REQUEST_TIMEOUT: '10s',
    TOMATO_TAP_SERVER_HEADERS_TIMEOUT: '20s',
  }), /must not exceed/);
});
