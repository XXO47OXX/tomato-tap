import { detectQuotaSignal, inferLongCooldownFromBody } from '../providers/quota/quota_infer.mjs';
import { realModelPolicy } from './model-policy.mjs';
import { adaptRelayRequest } from './request-adapter.mjs';
import {
  extractRequestModel,
  rewriteRequestModel,
  safeJsonParse,
  stripEmptyUserMessagesForOpenAI,
  validateOpenAIChatRequest,
} from '../gateway/request-body.mjs';
import { validateOpenAIResponse } from './response-validator.mjs';
import { applyRelayAuth, authBearer } from '../providers/protocol-registry.mjs';
import { resolveUpstreamPath } from '../providers/vendor-loader.mjs';
import { deliverResponseToClient, rejectByPath } from '../gateway/http-response.mjs';
import {
  nextRoute429Recovery,
  routeCandidateIndexes,
  routeTriedCount,
} from './route-retry.mjs';

// Dispatcher for physical vendor routes and dedicated bridges.
export function createOrdinaryDispatcher({
  maxRetries,
  retryBackoffMs,
  retryableStatuses,
  openSampleLog,
  getRuntime,
  pickKeyAndAcquire,
  keyRuntimeAvailable,
  quotaCanDispatch,
  rateLimitCanDispatch,
  keyPoolStatus,
  pickHeaders,
  maskHeaders,
  sendUpstreamBuffered,
  recordStickyProxyResult,
  recordQuotaRequestResult,
  recordCandidateQualification,
  parseRetryAfter,
  releaseKey,
  releaseKeyCapacityOnly,
  rejectInvalidRequest,
  recordRetrySuccess,
  recordPoolExhausted,
  recordAllAttemptsFailed,
  recordTerminal,
  recordExhausted,
  timeouts = {},
  logger = console,
}) {
  const isRetryable = (status, networkError) => {
    if (!networkError) return retryableStatuses.has(status);
    return !['ECANCELED', 'ERESPONSETOOLARGE'].includes(networkError.code);
  };

  return async function dispatchOrdinary({
    clientReq,
    clientRes,
    id,
    ts,
    url,
    format,
    reqBuf,
    vendor,
    route,
    requestedModel = extractRequestModel(reqBuf),
  }) {
    const abortController = new AbortController();
    const abortForClient = () => {
      if (!abortController.signal.aborted) abortController.abort();
    };
    clientReq.once?.('aborted', abortForClient);
    clientRes.once?.('close', () => {
      if (!clientRes.writableEnded) abortForClient();
    });
    const { keyPool, keyState, vendors, modelPolicy } = getRuntime();
    const excluded = new Set();
    let lastResult = null;
    let lastKey = null;
    let attemptsMade = 0;
    const vendorConfig = vendors[vendor];
    const totalTimeoutMs = Math.max(
      1,
      Number(vendorConfig?.requestTimeouts?.totalMs ?? timeouts.totalTimeoutMs)
        || 10 * 60_000,
    );
    const firstByteTimeoutMs = Math.max(
      1,
      Number(vendorConfig?.requestTimeouts?.firstByteMs ?? timeouts.firstByteTimeoutMs)
        || 2 * 60_000,
    );
    const deadlineAt = Date.now() + totalTimeoutMs;
    let effectiveBody = route.injectBody ? route.injectBody(reqBuf, clientReq.headers) : reqBuf;
    const routeFormat = route.format || route.apiFormat;
    const routeCandidates = routeCandidateIndexes(keyPool, {
      vendor,
      requestedModel,
      format,
      runtimeAvailable: keyRuntimeAvailable,
    });
    let route429Waits = 0;

    if (routeFormat === 'openai' && !vendorConfig?.preserveIncomingBody) {
      effectiveBody = stripEmptyUserMessagesForOpenAI(effectiveBody, route.prefix, { logger });
      const chatError = validateOpenAIChatRequest(effectiveBody);
      if (chatError) {
        const bodyLength = effectiveBody?.length || 0;
        const modelForLog = requestedModel || extractRequestModel(effectiveBody) || '<none>';
        logger.warn(
          `[${id}] 400 invalid openai chat request route=${route.prefix} ` +
          `model=${modelForLog} reason="${chatError}" bodyLen=${bodyLength}`,
        );
        return rejectInvalidRequest(clientRes, chatError, route);
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (Date.now() >= deadlineAt || abortController.signal.aborted) break;
      const keyPick = pickKeyAndAcquire(excluded, vendor, requestedModel, format);
      if (!keyPick) {
        const recovery = route429Waits < maxRetries
          ? nextRoute429Recovery(routeCandidates, keyState, {
            maxWaitMs: Number(vendorConfig?.retryPolicy?.waitFor429RecoveryMs || 0),
          })
          : null;
        if (recovery) {
          route429Waits += 1;
          excluded.delete(recovery.keyIndex);
          logger.log(
            `[${id}] WAIT route-429-recovery key=${keyPool[recovery.keyIndex]?.name || '?'} ` +
            `delay_ms=${recovery.delayMs} wait=${route429Waits}/${maxRetries} ` +
            `${clientReq.method} ${url}`,
          );
          await sleep(recovery.delayMs + 25);
          attempt -= 1;
          continue;
        }

        const reachable = keyPool.reduce((count, key, index) => {
          if (excluded.has(index)) return count;
          if (vendor && key.vendor !== vendor) return count;
          if (format && key.apiFormats instanceof Set && !key.apiFormats.has(format)) return count;
          if (requestedModel && key.modelSet && !key.modelSet.has(requestedModel)) return count;
          if (!keyRuntimeAvailable(key)) return count;
          if (!quotaCanDispatch(key.deploymentId, Date.now())) return count;
          if (!rateLimitCanDispatch(key, keyState[index], Date.now())) return count;
          return count + 1;
        }, 0);
        if (attempt < maxRetries && reachable > 0) {
          await sleep(retryBackoffMs[Math.min(attempt, retryBackoffMs.length - 1)]);
          continue;
        }

        recordPoolExhausted();
        const tried = routeTriedCount(routeCandidates, excluded);
        const candidateSet = new Set(routeCandidates);
        const poolState = keyPoolStatus().filter((_, index) => candidateSet.has(index));
        logger.log(
          `[${id}] BLOCK pool-exhausted  attempt=${attempt}  excluded=${tried}/${routeCandidates.length}  ` +
          `${clientReq.method} ${url}  ${JSON.stringify(poolState)}`,
        );
        return rejectByPath(
          clientRes,
          url,
          503,
          `tomato-tap: pool exhausted (${tried}/${routeCandidates.length} eligible route keys tried, rest saturated/in cooldown)`,
          route,
        );
      }

      const attemptTag = attempt === 0 ? '' : `-a${attempt}`;
      const log = openSampleLog(`${ts}-${id}${attemptTag}.log`);
      let dispatchedBody = effectiveBody;
      let upstreamModel = requestedModel;
      if (keyPick.modelAliases && requestedModel) {
        const alias = keyPick.modelAliases.get(requestedModel.toLowerCase());
        if (alias && alias !== requestedModel) {
          const rewritten = rewriteRequestModel(effectiveBody, clientReq.headers, alias);
          if (rewritten !== effectiveBody) {
            dispatchedBody = rewritten;
            upstreamModel = alias;
          }
        }
      }
      dispatchedBody = adaptRelayRequest(dispatchedBody, clientReq.headers, keyPick.requestPolicy);
      const upstreamHeaders = pickHeaders(
        clientReq.headers,
        format,
        vendor,
        keyPick.host,
        keyPick,
        {
          preserveIncomingUserAgent: vendors[vendor]?.preserveIncomingUserAgent === true,
          preserveIncomingHeaders: vendors[vendor]?.preserveIncomingHeaders === true,
        },
      );
      applyRelayAuth(upstreamHeaders, keyPick.value, keyPick.authType, route.setAuth || authBearer);
      if (dispatchedBody !== reqBuf) upstreamHeaders['content-length'] = String(dispatchedBody.length);
      const upstreamPath = resolveUpstreamPath(route, keyPick, url);
      const isDefaultPort = (keyPick.proto === 'http' && keyPick.port === 80)
        || (keyPick.proto !== 'http' && keyPick.port === 443);
      const portSuffix = isDefaultPort ? '' : `:${keyPick.port}`;
      const upstreamUrl = `${keyPick.proto || 'https'}://${keyPick.host}${portSuffix}${upstreamPath}`;

      log.write(`==== REQUEST ${id} attempt=${attempt} ${ts} ====\n`);
      const aliasNote = upstreamModel !== requestedModel ? ` alias=${requestedModel}→${upstreamModel}` : '';
      log.write(`${clientReq.method} ${url}  ->  ${upstreamUrl}  key=${keyPick.name} vendor=${vendor}${aliasNote}\n`);
      log.write('-- request headers (sent to upstream) --\n');
      log.write(JSON.stringify(maskHeaders(upstreamHeaders), null, 2) + '\n');
      log.write(`-- request body${dispatchedBody !== reqBuf ? ' (post-inject/alias)' : ''} --\n`);
      if (dispatchedBody.length > 0) log.write(dispatchedBody);
      log.write('\n');

      const upstreamResult = await sendUpstreamBuffered(
        dispatchedBody,
        clientReq.method,
        upstreamPath,
        upstreamHeaders,
        keyPick,
        {
          firstByteTimeoutMs: Math.min(
            firstByteTimeoutMs,
            Math.max(1, deadlineAt - Date.now()),
          ),
          totalTimeoutMs: Math.max(1, deadlineAt - Date.now()),
          signal: abortController.signal,
        },
      );
      attemptsMade = attempt + 1;
      recordStickyProxyResult(keyPick.idx, upstreamResult);

      log.write(`-- response status --\n${upstreamResult.status} ${upstreamResult.statusMessage}${upstreamResult.networkError ? ` [networkError: ${upstreamResult.networkError.message}]` : ''}\n`);
      if (!upstreamResult.networkError) {
        log.write('-- response headers --\n');
        log.write(JSON.stringify(maskHeaders(upstreamResult.headers), null, 2) + '\n');
        log.write('-- response body --\n');
        if (upstreamResult.body.length > 0) log.write(upstreamResult.body);
      }

      const transformed = route.transformResponse
        ? route.transformResponse(upstreamResult, requestedModel)
        : upstreamResult;
      const internalFailure = upstreamResult.failureOrigin === 'internal';
      const quotaSignal = internalFailure ? null : detectQuotaSignal(transformed, keyPick);
      const result = inferLongCooldownFromBody(transformed, keyPick, quotaSignal);
      if (!internalFailure) recordQuotaRequestResult(keyPick, upstreamResult, quotaSignal);
      if (!internalFailure
          && requestedModel
          && format === 'openai'
          && realModelPolicy(modelPolicy, requestedModel)) {
        const validation = validateOpenAIResponse(result, { requestBody: safeJsonParse(reqBuf) || {} });
        recordCandidateQualification(keyPick, requestedModel, validation, result);
      }

      const retryAfterMs = upstreamResult.status === 429 ? parseRetryAfter(result.headers) : null;
      if (internalFailure) releaseKeyCapacityOnly(keyPick.idx, requestedModel);
      else releaseKey(keyPick.idx, upstreamResult.status, retryAfterMs, requestedModel);
      if (result !== upstreamResult) {
        log.write(`-- post-transform status --\n${result.status} ${result.statusMessage}\n`);
        log.write('-- post-transform body --\n');
        if (result.body && result.body.length > 0) log.write(result.body);
      }
      log.write(`\n==== END ${id} attempt=${attempt} ====\n`);
      log.end();

      if (isRetryable(result.status, result.networkError)) {
        excluded.add(keyPick.idx);
        lastResult = result;
        lastKey = keyPick;
        const tag = result.networkError ? `ERR(${result.networkError.code || 'net'})` : String(result.status);
        if (Date.now() < deadlineAt && !abortController.signal.aborted) {
          logger.log(`[${id}] attempt=${attempt} key=${keyPick.name} -> ${tag}  (retrying, excluded=${excluded.size})`);
          continue;
        }
        break;
      }

      if (result.networkError) {
        lastResult = result;
        lastKey = keyPick;
        break;
      }

      recordRetrySuccess(attempt);
      deliverResponseToClient(clientRes, result);
      recordTerminal({
        clientReq,
        id,
        url,
        reqBuf,
        requestedModel,
        keyPick,
        result,
        attempt,
        route,
      });
      return;
    }

    recordAllAttemptsFailed();
    if (lastResult && !lastResult.networkError) {
      deliverResponseToClient(clientRes, lastResult);
      recordExhausted({
        clientReq,
        id,
        url,
        requestedModel,
        lastResult,
        lastKey,
        route,
        attempts: attemptsMade,
      });
      return;
    }

    const errorMessage = lastResult?.networkError?.message || 'unknown';
    rejectByPath(
      clientRes,
      url,
      502,
      `tomato-tap: ${attemptsMade} attempts failed (last: ${errorMessage})`,
      route,
    );
    logger.log(
      `[${id}] ${clientReq.method} ${url} -> 502  attempts=${attemptsMade}  ` +
      `ALL_NETWORK_ERRORS  (last: ${errorMessage})`,
    );
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
