import http from 'node:http';
import https from 'node:https';

import { createProxyAgentPool, selectUpstreamAgent } from './proxy-agent-pool.mjs';

const DEFAULT_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 512,
  maxFreeSockets: 256,
});

const DEFAULT_PROXY_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 32,
});

// Buffered HTTP transport with direct and proxy-agent pools.
export function createUpstreamHttpTransport({
  sharedProxyUrl = '',
  sharedProxyVendor = '',
  maxResponseBytes = 32 * 1024 * 1024,
  logger = console,
  agentOptions = DEFAULT_AGENT_OPTIONS,
  proxyAgentOptions = DEFAULT_PROXY_AGENT_OPTIONS,
} = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error('upstream-http: maxResponseBytes must be a positive safe integer');
  }
  const httpsAgent = new https.Agent(agentOptions);
  const httpAgent = new http.Agent(agentOptions);
  const proxyAgents = createProxyAgentPool({ agentOptions: proxyAgentOptions });

  function sendBuffered(reqBuf, method, urlPath, upstreamHeaders, keyPick, timeout = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let firstByteMs = 0;
      let firstByteTimer = null;
      let totalTimer = null;
      let abortHandler = null;
      let activeRequest = null;
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (firstByteTimer) clearTimeout(firstByteTimer);
        if (totalTimer) clearTimeout(totalTimer);
        if (abortHandler && timeout.signal) timeout.signal.removeEventListener('abort', abortHandler);
        resolve({
          ...result,
          firstByteMs,
          elapsedMs: Date.now() - startedAt,
        });
      };
      const timeoutError = (phase) => {
        const error = new Error(`upstream ${phase} timeout`);
        error.code = 'ETIMEDOUT';
        return error;
      };
      const useHttp = keyPick.proto === 'http';
      const port = keyPick.port || (useHttp ? 80 : 443);
      const client = useHttp ? http : https;
      const useSharedProxy = keyPick.vendor === sharedProxyVendor || keyPick.useProxy;
      const allowProxyFallback = keyPick.useProxy === true && keyPick.vendor !== sharedProxyVendor;
      let fallbackDone = false;

      const emitRequest = (useProxy) => {
        const agent = selectUpstreamAgent({
          targetProtocol: useHttp ? 'http:' : 'https:',
          proxyUrl: keyPick.proxyUrl,
          dedicatedPool: proxyAgents,
          useSharedProxy: useProxy,
          sharedProxyUrl,
          directHttpAgent: httpAgent,
          directHttpsAgent: httpsAgent,
        });
        const upstreamReq = client.request({
          host: keyPick.host,
          port,
          method,
          path: urlPath,
          headers: upstreamHeaders,
          agent,
        }, (upstreamRes) => {
          firstByteMs = Date.now() - startedAt;
          if (firstByteTimer) clearTimeout(firstByteTimer);
          const chunks = [];
          let responseBytes = 0;
          const declaredLength = Number(upstreamRes.headers['content-length'] || 0);
          if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
            const error = responseTooLarge(maxResponseBytes);
            settle({
              status: 0,
              statusMessage: '',
              headers: {},
              body: Buffer.alloc(0),
              networkError: error,
              failureOrigin: 'internal',
            });
            upstreamRes.destroy(error);
            return;
          }
          upstreamRes.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              const error = responseTooLarge(maxResponseBytes);
              settle({
                status: 0,
                statusMessage: '',
                headers: {},
                body: Buffer.alloc(0),
                networkError: error,
                failureOrigin: 'internal',
              });
              upstreamRes.destroy(error);
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            settle({
              status: upstreamRes.statusCode || 0,
              statusMessage: upstreamRes.statusMessage || '',
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
              networkError: null,
            });
          });
          upstreamRes.on('error', (error) => {
            settle({ status: 0, statusMessage: '', headers: {}, body: Buffer.alloc(0), networkError: error });
          });
        });
        activeRequest = upstreamReq;
        upstreamReq.on('error', (error) => {
          if (settled) return;
          if (useProxy && allowProxyFallback && !fallbackDone && !timeout.signal?.aborted) {
            fallbackDone = true;
            logger.log(`[proxy-fallback] ${keyPick.host} 代理不可达，直连重试 (${error.code || error.message})`);
            emitRequest(false);
            return;
          }
          settle({ status: 0, statusMessage: '', headers: {}, body: Buffer.alloc(0), networkError: error });
        });
        if (reqBuf.length > 0) upstreamReq.write(reqBuf);
        upstreamReq.end();
      };

      if (timeout.signal) {
        abortHandler = () => {
          const error = new Error('client disconnected');
          error.code = 'ECANCELED';
          settle({
            status: 0,
            statusMessage: '',
            headers: {},
            body: Buffer.alloc(0),
            networkError: error,
            failureOrigin: 'internal',
          });
          activeRequest?.destroy(error);
        };
        if (timeout.signal.aborted) {
          abortHandler();
          return;
        }
        timeout.signal.addEventListener('abort', abortHandler, { once: true });
      }
      if (Number.isFinite(timeout.firstByteTimeoutMs) && timeout.firstByteTimeoutMs > 0) {
        firstByteTimer = setTimeout(() => {
          const error = timeoutError('first-byte');
          settle({ status: 0, statusMessage: '', headers: {}, body: Buffer.alloc(0), networkError: error });
          activeRequest?.destroy(error);
        }, timeout.firstByteTimeoutMs);
      }
      if (Number.isFinite(timeout.totalTimeoutMs) && timeout.totalTimeoutMs > 0) {
        totalTimer = setTimeout(() => {
          const error = timeoutError('total');
          settle({ status: 0, statusMessage: '', headers: {}, body: Buffer.alloc(0), networkError: error });
          activeRequest?.destroy(error);
        }, timeout.totalTimeoutMs);
      }
      emitRequest(useSharedProxy);
    });
  }

  function close() {
    httpAgent.destroy();
    httpsAgent.destroy();
    proxyAgents.destroy?.();
  }

  return Object.freeze({ sendBuffered, close });
}

function responseTooLarge(maxResponseBytes) {
  const error = new Error(
    `upstream response exceeds configured limit (${maxResponseBytes} bytes)`,
  );
  error.code = 'ERESPONSETOOLARGE';
  return error;
}
