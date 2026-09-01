import { nextEligibilityRetryDelay } from './candidate-eligibility.mjs';
import {
  deploymentMatchesRequest,
  pairId,
  selectLogicalCandidate,
} from './logical-scheduler.mjs';
import { realModelPolicy } from './model-policy.mjs';
import { adaptLogicalRequest, validateRequestPolicyInput } from './request-adapter.mjs';
import { validateOpenAIResponse } from './response-validator.mjs';
import { annotateResponse } from './response-metadata.mjs';
import { detectQuotaSignal, inferLongCooldownFromBody } from '../providers/quota/quota_infer.mjs';
import { applyRelayAuth, authBearer } from '../providers/protocol-registry.mjs';
import { resolveUpstreamPath } from '../providers/vendor-loader.mjs';
import { safeJsonParse } from '../gateway/request-body.mjs';
import { deliverResponseToClient } from '../gateway/http-response.mjs';

export function createLogicalDispatcher({
  scheduler,
  deployments,
  openSampleLog,
  getModelPolicy,
  getVendors,
  pickHeaders,
  maskHeaders,
  sendUpstreamBuffered,
  recordQuotaRequestResult,
  parseRetryAfter,
  releaseKeyCapacityOnly,
  recordStickyProxyResult,
  recordCandidateQualification,
  recordRetrySuccess,
  recordAllAttemptsFailed,
  recordLogicalAttempt,
  recordLogicalUsage,
  logger = console,
}) {
  return async function dispatchLogical({
    clientReq,
    clientRes,
    id,
    ts,
    url,
    reqBuf,
    logicalRequest,
    routePrefix,
  }) {
    try {
      validateRequestPolicyInput(reqBuf, clientReq.headers, logicalRequest.requestPolicy);
    } catch (error) {
      return rejectLogical(
        clientRes,
        400,
        'mimo_tap_invalid_logical_request',
        error.message,
        { logical_model: logicalRequest.logicalModel, task: logicalRequest.taskName || '' },
      );
    }
    const startedAt = Date.now();
    const abortController = new AbortController();
    const abortForDisconnect = () => {
      if (!clientRes.writableEnded) abortController.abort();
    };
    clientReq.once('aborted', abortForDisconnect);
    clientRes.once('close', abortForDisconnect);
    const requestedDeadline = Number(gatewayHeader(clientReq.headers, 'deadline-ms'));
    const deadlineMs = Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? Math.max(1000, Math.min(requestedDeadline, logicalRequest.deadlineMs))
      : logicalRequest.deadlineMs;
    const deadlineAt = startedAt + deadlineMs;
    const admissionDeadlineAt = Math.min(
      deadlineAt,
      startedAt + (logicalRequest.logicalAdmissionWaitMs || 0),
    );
    let lease = scheduler.enter(logicalRequest);
    if (!lease && admissionDeadlineAt > Date.now()) {
      while (!lease && Date.now() < admissionDeadlineAt) {
        const remaining = admissionDeadlineAt - Date.now();
        if (remaining <= 0) break;
        await sleepUntilOrAbort(Math.min(100, remaining), abortController.signal);
        if (abortController.signal.aborted) return;
        lease = scheduler.enter(logicalRequest);
      }
    }
    if (!lease) {
      return rejectLogical(
        clientRes,
        503,
        'mimo_tap_logical_congested',
        `logical model ${logicalRequest.logicalModel} is at its concurrency limit`,
        { logical_model: logicalRequest.logicalModel, task: logicalRequest.taskName || '' },
      );
    }

    const sessionId = gatewayHeader(clientReq.headers, 'session-id')
      || gatewayHeader(clientReq.headers, 'session');
    const previousModel = gatewayHeader(clientReq.headers, 'previous-model');
    const requestBody = safeJsonParse(reqBuf) || {};
    const excludedPairs = new Set();
    const attemptedModels = new Set();
    const modelAttemptCounts = new Map();
    let avoidModel = logicalRequest.preferDifferentFromPrevious ? previousModel : '';
    let attempts = 0;
    let lastFailure = 'no_eligible_deployment';

    try {
      while (attempts < logicalRequest.maxAttempts && Date.now() < deadlineAt) {
        const now = Date.now();
        const remainingMs = deadlineAt - now;
        const availableDeployments = deployments.list(logicalRequest, now);
        const selection = selectLogicalCandidate({
          scheduler,
          request: logicalRequest,
          deployments: availableDeployments,
          now,
          sessionId,
          avoidModel,
          excludedPairs,
          remainingMs,
          modelAttemptCounts,
        });
        if (!selection) {
          const retryDelay = logicalRetryDelay(
            logicalRequest,
            availableDeployments,
            excludedPairs,
            now,
            deadlineAt,
          );
          if (retryDelay > 0) {
            await sleepUntilOrAbort(retryDelay, abortController.signal);
            if (abortController.signal.aborted) return;
            continue;
          }
          break;
        }

        const keyPick = deployments.acquire(selection, now);
        if (!keyPick) continue;
        attempts += 1;
        attemptedModels.add(selection.candidateModel.toLowerCase());
        modelAttemptCounts.set(
          selection.candidateModel.toLowerCase(),
          (modelAttemptCounts.get(selection.candidateModel.toLowerCase()) || 0) + 1,
        );
        const modelPolicy = realModelPolicy(getModelPolicy(), selection.candidateModel);
        const selectedRoute = deployments.routeForVendor(keyPick.vendor);
        let upstreamModel = selection.candidateModel;
        const alias = keyPick.modelAliases?.get(selection.candidateModel.toLowerCase());
        if (alias) upstreamModel = alias;

        let upstreamResult;
        let result;
        let validation;
        let retryAfterMs = null;
        let released = false;
        const attemptStartedAt = Date.now();
        const attemptTag = attempts === 1 ? '' : `-a${attempts - 1}`;
        const log = openSampleLog(`${ts}-${id}${attemptTag}.log`);
        try {
          const dispatchedBody = adaptLogicalRequest(reqBuf, clientReq.headers, {
            upstreamModel,
            thinkingAdapter: modelPolicy.thinkingAdapter,
            maxTokensMultiplier: modelPolicy.maxTokensMultiplier,
            logicalRequestPolicy: logicalRequest.requestPolicy,
            requestPolicy: keyPick.requestPolicy,
          });
          const vendors = getVendors();
          const upstreamHeaders = pickHeaders(
            clientReq.headers,
            selectedRoute.format,
            keyPick.vendor,
            keyPick.host,
            keyPick,
            {
              preserveIncomingUserAgent: vendors[keyPick.vendor]?.preserveIncomingUserAgent === true,
              preserveIncomingHeaders: vendors[keyPick.vendor]?.preserveIncomingHeaders === true,
            },
          );
          applyRelayAuth(
            upstreamHeaders,
            keyPick.value,
            keyPick.authType,
            selectedRoute.setAuth || authBearer,
          );
          upstreamHeaders['content-length'] = String(dispatchedBody.length);
          const syntheticPath = `${selectedRoute.prefix}/chat/completions`;
          const upstreamPath = resolveUpstreamPath(selectedRoute, keyPick, syntheticPath);
          const isDefaultPort = (keyPick.proto === 'http' && keyPick.port === 80)
            || (keyPick.proto !== 'http' && keyPick.port === 443);
          const portSuffix = isDefaultPort ? '' : `:${keyPick.port}`;
          const upstreamUrl = `${keyPick.proto || 'https'}://${keyPick.host}${portSuffix}${upstreamPath}`;

          log.write(`==== LOGICAL REQUEST ${id} attempt=${attempts} ${ts} ====\n`);
          log.write(`${clientReq.method} ${url} -> ${upstreamUrl} deployment=${keyPick.deploymentId} vendor=${keyPick.vendor} model=${selection.candidateModel} resolved=${upstreamModel}\n`);
          log.write(`-- request headers (sent to upstream) --\n${JSON.stringify(maskHeaders(upstreamHeaders), null, 2)}\n`);
          log.write('-- request body (logical-adapted) --\n');
          if (dispatchedBody.length > 0) log.write(dispatchedBody);
          log.write('\n');

          const attemptRemainingMs = Math.max(1, deadlineAt - Date.now());
          upstreamResult = await sendUpstreamBuffered(
            dispatchedBody,
            clientReq.method,
            upstreamPath,
            upstreamHeaders,
            keyPick,
            {
              firstByteTimeoutMs: Math.min(selection.firstByteTimeoutMs, attemptRemainingMs),
              totalTimeoutMs: Math.min(selection.timeoutMs, attemptRemainingMs),
              signal: abortController.signal,
            },
          );
          const transformed = selectedRoute.transformResponse
            ? selectedRoute.transformResponse(upstreamResult, upstreamModel)
            : upstreamResult;
          const quotaSignal = detectQuotaSignal(transformed, keyPick);
          result = inferLongCooldownFromBody(transformed, keyPick, quotaSignal);
          recordQuotaRequestResult(keyPick, upstreamResult, quotaSignal);
          retryAfterMs = upstreamResult.status === 429 ? parseRetryAfter(result.headers) : null;
          validation = validateOpenAIResponse(result, { requestBody });

          log.write(`-- response status --\n${result.status} ${result.statusMessage}${result.networkError ? ` [networkError: ${result.networkError.message}]` : ''}\n`);
          if (result.body?.length > 0) {
            log.write('-- response body --\n');
            log.write(result.body);
            log.write('\n');
          }
          log.write(`-- validation --\n${JSON.stringify(validation)}\n`);
        } catch (error) {
          upstreamResult = {
            status: 0,
            statusMessage: '',
            headers: {},
            body: Buffer.alloc(0),
            networkError: error,
            failureOrigin: 'internal',
            firstByteMs: 0,
            elapsedMs: Date.now() - attemptStartedAt,
          };
          result = upstreamResult;
          validation = {
            valid: false,
            failureClass: 'adapter_or_dispatch',
            upstreamReportedModel: '',
          };
          log.write(`-- internal attempt error --\n${error.message}\n`);
        } finally {
          if (!released) {
            if (upstreamResult?.networkError?.code === 'ECANCELED'
                || upstreamResult?.failureOrigin === 'internal') {
              releaseKeyCapacityOnly(keyPick.idx, keyPick.candidateModel);
            } else {
              recordStickyProxyResult(keyPick.idx, upstreamResult);
              deployments.release(keyPick, upstreamResult?.status || 0, retryAfterMs);
            }
            released = true;
          }
          log.write(`==== END ${id} attempt=${attempts} ====\n`);
          log.end();
        }

        const canceled = upstreamResult?.networkError?.code === 'ECANCELED';
        if (canceled || clientRes.destroyed) return;

        scheduler.record({
          deploymentId: keyPick.deploymentId,
          model: selection.candidateModel,
          valid: validation.valid,
          latencyMs: result.elapsedMs || (Date.now() - attemptStartedAt),
          firstByteMs: result.firstByteMs || 0,
          failureClass: validation.failureClass,
          sessionId,
        });
        recordCandidateQualification(keyPick, selection.candidateModel, validation, result);

        if (validation.valid) {
          const annotated = annotateResponse(result, {
            requestedModel: logicalRequest.logicalModel,
            taskName: logicalRequest.taskName,
            selectedModel: selection.candidateModel,
            resolvedModel: upstreamModel,
            upstreamReportedModel: validation.upstreamReportedModel,
            deploymentId: keyPick.deploymentId,
            vendor: keyPick.vendor,
            attempts,
            modelSwitched: attemptedModels.size > 1,
          });
          recordRetrySuccess(attempts - 1);
          deliverResponseToClient(clientRes, annotated);
          recordLogicalUsage({
            id,
            requestedModel: logicalRequest.logicalModel,
            resolvedModel: upstreamModel,
            result: annotated,
            keyPick,
            attempts,
            requestBody: reqBuf,
            routePrefix: routePrefix || null,
          });
          logger.log(
            `[${id}] ${clientReq.method} ${url} -> 200 deployment=${keyPick.deploymentId} ` +
            `attempts=${attempts} logical=${logicalRequest.logicalModel} model=${upstreamModel}`,
          );
          return;
        }

        recordLogicalAttempt({
          id,
          requestedModel: logicalRequest.logicalModel,
          resolvedModel: upstreamModel,
          result,
          keyPick,
          attempt: attempts,
          requestBody: reqBuf,
          routePrefix: routePrefix || null,
          failureClass: validation.failureClass,
        });

        lastFailure = validation.failureClass || 'invalid_response';
        excludedPairs.add(pairId(keyPick.deploymentId, selection.candidateModel));
        if (!['network', 'http_status'].includes(lastFailure)) avoidModel = selection.candidateModel;
        logger.log(
          `[${id}] logical attempt=${attempts} deployment=${keyPick.deploymentId} ` +
          `model=${selection.candidateModel} failure=${lastFailure} retrying`,
        );
      }

      recordAllAttemptsFailed();
      return rejectLogical(
        clientRes,
        503,
        'mimo_tap_logical_exhausted',
        `logical model ${logicalRequest.logicalModel} exhausted eligible deployments`,
        {
          logical_model: logicalRequest.logicalModel,
          task: logicalRequest.taskName || '',
          attempts,
          last_failure: lastFailure,
        },
      );
    } finally {
      clientReq.removeListener('aborted', abortForDisconnect);
      clientRes.removeListener('close', abortForDisconnect);
      lease.release();
    }
  };
}

export function logicalHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export function gatewayHeader(headers, suffix) {
  return logicalHeader(headers, `x-tomato-tap-${suffix}`)
    || logicalHeader(headers, `x-mimo-${suffix}`);
}

export function rejectLogical(clientRes, status, type, message, details = {}) {
  const body = Buffer.from(JSON.stringify({
    error: { code: String(status), type, message, ...details },
  }));
  deliverResponseToClient(clientRes, {
    status,
    statusMessage: status === 400 ? 'Bad Request' : 'Service Unavailable',
    headers: { 'content-type': 'application/json' },
    body,
    networkError: null,
  });
}

function logicalRetryDelay(request, deployments, excludedPairs, now, deadlineAt) {
  const eligible = deployments.filter((deployment) => (
    deploymentMatchesRequest(request, deployment)
    && !excludedPairs.has(pairId(deployment.deploymentId, deployment.model))
  ));
  return nextEligibilityRetryDelay(eligible, now, deadlineAt);
}

function sleepUntilOrAbort(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
