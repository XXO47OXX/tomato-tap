import { evaluateCandidate } from './candidate-eligibility.mjs';
import { activeCooldownReason } from '../state/key-cooldown.mjs';
import { realModelPolicy } from './model-policy.mjs';

// Concrete key/model deployments used by logical routes.
export function createLogicalDeploymentRegistry({
  getRuntime,
  vendorCap,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  keyRuntimeAvailable,
  quotaCanDispatch,
  keyRateLimitStatus,
  consumeRateLimit,
  vendorUnboundedModelConcurrency,
  acquireModelSlot,
  releaseModelSlot,
  advanceKeyCursor,
  releaseKey,
}) {
  function routeForVendor(vendor) {
    const { vendors } = getRuntime();
    const routes = vendors[vendor]?.routes || [];
    return routes
      .filter((route) => route.format === 'openai' && !route.prefix.endsWith('/messages'))
      .sort((left, right) => left.prefix.length - right.prefix.length)[0] || null;
  }

  function supportsModel(key, model) {
    const wanted = String(model || '').toLowerCase();
    if (!wanted) return false;
    if (key.canonicalModelSet instanceof Set) {
      return [...key.canonicalModelSet].some((value) => String(value).toLowerCase() === wanted);
    }
    if (key.modelSet instanceof Set) {
      return [...key.modelSet].some((value) => String(value).toLowerCase() === wanted);
    }
    const { vendors } = getRuntime();
    const nativeModels = key.nativeModels || vendors[key.vendor]?.nativeModels;
    return Array.isArray(nativeModels)
      && nativeModels.some((value) => String(value).toLowerCase() === wanted);
  }

  function vendorInflight(vendor, keyPool, keyState) {
    let total = 0;
    for (let index = 0; index < keyPool.length; index++) {
      if (keyPool[index].vendor === vendor) total += keyState[index].inflight;
    }
    return total;
  }

  function list(request, now = Date.now(), { includeLogicalAdmission = false } = {}) {
    const {
      vendors,
      keyPool,
      keyState,
      modelPolicy,
      quotaManager,
      quotaPersistenceHealthy,
      stickyRuntime,
      candidateQualifications,
      modelInflight,
      logicalScheduler,
      timeRouteScheduler,
    } = getRuntime();
    const deployments = [];
    const quotaWindows = new Map(
      quotaManager.snapshot().map((window) => [window.deploymentId, window]),
    );
    const schedulerRuntime = logicalScheduler.snapshot(now);
    const logicalActive = schedulerRuntime.activeByLogical[request.logicalModel] || 0;

    for (let keyIndex = 0; keyIndex < keyPool.length; keyIndex++) {
      const key = keyPool[keyIndex];
      const state = keyState[keyIndex];
      if (vendors[key.vendor]?.logicalEligible === false) continue;
      if (key.apiFormats instanceof Set && !key.apiFormats.has('openai')) continue;
      const route = routeForVendor(key.vendor);
      if (!route) continue;
      const wideCap = vendorCap(key.vendor, 'vendorMaxInflight');
      const vendorActive = vendorInflight(key.vendor, keyPool, keyState);
      const vendorBlockedReason = checkVendorConstraints(key.vendor, vendors[key.vendor]);
      const quotaWindow = quotaWindows.get(key.deploymentId);
      const rate = keyRateLimitStatus(key, state, now);

      for (const candidateModel of request.candidates) {
        if (!supportsModel(key, candidateModel)) continue;
        const pricingBlockedReason = checkVendorPricingCoverage(
          key.vendor,
          vendors[key.vendor],
          candidateModel,
        );
        const policy = realModelPolicy(modelPolicy, candidateModel);
        if (!policy) continue;
        const modelLower = candidateModel.toLowerCase();
        let deadUntil = state.deadModels.get(modelLower) || 0;
        if (deadUntil && deadUntil <= now) {
          state.deadModels.delete(modelLower);
          deadUntil = 0;
        }
        const deploymentId = key.deploymentId || `${key.vendor}-${keyIndex + 1}`;
        const qualification = candidateQualifications.get(deploymentId, policy.name);
        const eligibility = evaluateCandidate({
          configured: true,
          credentialPresent: true,
          expiresAt: key.expiresAtMs,
          proxyAvailable: stickyRuntime.isKeyAvailable(key),
          quotaState: quotaPersistenceHealthy ? (quotaWindow?.state || 'open') : 'closed',
          quotaNextProbeAt: quotaWindow?.nextProbeAt || 0,
          keyCooldownUntil: state.badUntil,
          keyCooldownReason: activeCooldownReason(state, now) || 'key_cooldown',
          modelCooldownUntil: deadUntil,
          modelCooldownReason: deadUntil > now ? 'model_cooldown' : '',
          rateLimitUntil: rate.retryAt,
          vendorBlockedReason,
          pricingBlockedReason,
          vendorCapacityFull: wideCap !== Infinity && vendorActive >= wideCap,
          keyCapacityFull: state.inflight >= state.cap,
          modelCapacityFull: (modelInflight.get(modelLower) || 0) >= policy.maxInflight,
          logicalAdmissionFull: includeLogicalAdmission && logicalActive >= request.maxInflight,
          latestValidatedOutcome: qualification?.latestValidatedOutcome,
          failureClass: qualification?.failureClass || '',
          lastValidatedAt: qualification?.lastValidatedAt || 0,
          qualificationNextProbeAt: qualification?.nextProbeAt || 0,
        }, now);
        deployments.push({
          keyIndex,
          deploymentId,
          vendor: key.vendor,
          route: route.prefix,
          relayAlias: key.relayAlias || key.name || '',
          model: policy.name,
          capabilities: policy.capabilities,
          qualityTier: policy.qualityTier,
          cap: state.cap,
          inflight: state.inflight,
          modelMaxInflight: policy.maxInflight,
          modelInflight: modelInflight.get(modelLower) || 0,
          badUntil: state.badUntil,
          deadUntil,
          baseWeight: (key.baseWeight || 1)
            * reliabilityWeight(state)
            * quotaManager.weightMultiplier(key.deploymentId, now),
          initialLatencyMs: policy.initialLatencyMs,
          firstByteTimeoutMs: policy.firstByteTimeoutMs,
          totalTimeoutMs: policy.totalTimeoutMs,
          requestPolicy: key.requestPolicy || null,
          eligibility,
        });
      }
    }
    return timeRouteScheduler
      ? timeRouteScheduler.filterDeployments(deployments, {
        logicalModel: request.logicalModel,
        now,
      }).deployments
      : deployments;
  }

  function acquire(selection, now = Date.now()) {
    if (!selection) return null;
    const { keyPool, keyState, modelPolicy, modelInflight } = getRuntime();
    const key = keyPool[selection.keyIndex];
    const state = keyState[selection.keyIndex];
    if (!key || !state) return null;
    if (key.apiFormats instanceof Set && !key.apiFormats.has('openai')) return null;
    if (!keyRuntimeAvailable(key)) return null;
    if (!quotaCanDispatch(key.deploymentId, now)) return null;
    if (!keyRateLimitStatus(key, state, now).allowed) return null;
    if (state.inflight >= state.cap || now < state.badUntil) return null;
    if (!supportsModel(key, selection.candidateModel)) return null;
    const deadUntil = state.deadModels.get(selection.candidateModel.toLowerCase()) || 0;
    if (deadUntil > now) return null;
    const policy = realModelPolicy(modelPolicy, selection.candidateModel);
    if (!policy) return null;
    const modelLower = selection.candidateModel.toLowerCase();
    if (!vendorUnboundedModelConcurrency(key.vendor)
        && (modelInflight.get(modelLower) || 0) >= policy.maxInflight) return null;
    const wideCap = vendorCap(key.vendor, 'vendorMaxInflight');
    if (wideCap !== Infinity && vendorInflight(key.vendor, keyPool, keyState) >= wideCap) return null;

    const tracksModelSlot = !vendorUnboundedModelConcurrency(key.vendor);
    if (tracksModelSlot && !acquireModelSlot(selection.candidateModel)) return null;
    if (!consumeRateLimit(state, key.rateLimitPolicy || null, now)) {
      if (tracksModelSlot) releaseModelSlot(selection.candidateModel);
      return null;
    }
    state.inflight += 1;
    advanceKeyCursor(selection.keyIndex, keyPool.length);
    return {
      idx: selection.keyIndex,
      deploymentId: key.deploymentId || `${key.vendor}-${selection.keyIndex + 1}`,
      name: key.name,
      value: key.value,
      host: key.host,
      vendor: key.vendor,
      quotaPolicy: key.quotaPolicy || null,
      modelAliases: key.modelAliases || null,
      apiFormats: key.apiFormats || null,
      requestPolicy: key.requestPolicy || null,
      headers: key.headers || null,
      authType: key.authType || null,
      pathPrefix: key.pathPrefix || '',
      proto: key.proto || 'https',
      port: key.port || (key.proto === 'http' ? 80 : 443),
      useProxy: key.useProxy === true,
      proxyUrl: key.proxyUrl || null,
      chatgptAccountId: key.chatgptAccountId || null,
      candidateModel: selection.candidateModel,
    };
  }

  function release(keyPick, status, retryAfterMs) {
    releaseKey(keyPick.idx, status, retryAfterMs, keyPick.candidateModel);
  }

  return Object.freeze({ list, acquire, release, routeForVendor, supportsModel });
}

export function reliabilityWeight(state) {
  const recent = state.outcomes || [];
  if (recent.length === 0) return 1;
  const successes = recent.filter((status) => status >= 200 && status < 300).length;
  if (successes === 0) return 0.1;
  return 1 + (4 * successes / recent.length);
}
