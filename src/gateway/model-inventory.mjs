import { activeCooldownReason } from '../state/key-cooldown.mjs';
import { evaluateCandidate, summarizeEligibility } from '../routing/candidate-eligibility.mjs';
import {
  deploymentMatchesRequest,
  selectLogicalCandidate,
} from '../routing/logical-scheduler.mjs';
import { realModelPolicy, resolveLogicalRequest } from '../routing/model-policy.mjs';
import { requestPolicyJSON } from '../routing/request-policy.mjs';

/**
 * Builds read-only model and deployment views for the control plane.
 *
 * Mutable gateway state stays owned by the application runtime. This service
 * receives a snapshot accessor so configuration reloads are reflected without
 * coupling the HTTP control plane to the composition root.
 */
export function createModelInventory({
  getRuntime,
  logicalDeployments,
  vendorCap,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  keyRateLimitStatus,
  logicalScheduler = null,
}) {
  if (typeof getRuntime !== 'function') {
    throw new TypeError('model inventory requires getRuntime()');
  }
  if (!logicalDeployments || typeof logicalDeployments.list !== 'function') {
    throw new TypeError('model inventory requires a logical deployment registry');
  }

  function vendorInflight(vendor, keyPool, keyState) {
    let total = 0;
    for (let index = 0; index < keyPool.length; index++) {
      if (keyPool[index].vendor === vendor) total += keyState[index].inflight;
    }
    return total;
  }

  function collectVendorModelHealth(vendor, now = Date.now(), requiredFormat = '') {
    const runtime = getRuntime();
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
    } = runtime;
    const vendorConfig = vendors[vendor];
    if (!vendorConfig) return [];

    const quotaWindows = new Map(
      quotaManager.snapshot().map((window) => [window.deploymentId, window]),
    );
    const wideCap = vendorCap(vendor, 'vendorMaxInflight');
    const activeForVendor = vendorInflight(vendor, keyPool, keyState);
    const vendorBlockedReason = checkVendorConstraints(vendor, vendorConfig);
    const models = new Map();

    for (let index = 0; index < keyPool.length; index++) {
      const key = keyPool[index];
      if (key.vendor !== vendor) continue;
      if (requiredFormat && key.apiFormats instanceof Set && !key.apiFormats.has(requiredFormat)) {
        continue;
      }

      const state = keyState[index];
      let keyModels = null;
      if (key.canonicalModelSet instanceof Set) keyModels = [...key.canonicalModelSet];
      else if (key.modelSet instanceof Set) keyModels = [...key.modelSet];
      else if (Array.isArray(vendorConfig.nativeModels)) keyModels = vendorConfig.nativeModels;
      else continue;

      for (const rawModel of keyModels) {
        if (typeof rawModel !== 'string') continue;
        const model = rawModel.trim();
        if (!model || model.startsWith('__')) continue;

        const normalizedModel = model.toLowerCase();
        let modelCooldownUntil = state.deadModels?.get(normalizedModel) || 0;
        if (modelCooldownUntil && modelCooldownUntil <= now) {
          state.deadModels.delete(normalizedModel);
          modelCooldownUntil = 0;
        }

        const deploymentId = key.deploymentId || `${vendor}-${index + 1}`;
        const quotaWindow = quotaWindows.get(deploymentId);
        const policy = realModelPolicy(modelPolicy, model);
        const qualification = candidateQualifications.get(deploymentId, model);
        const rateLimit = keyRateLimitStatus(key, state, now);
        const eligibility = evaluateCandidate({
          configured: true,
          credentialPresent: true,
          expiresAt: key.expiresAtMs,
          proxyAvailable: stickyRuntime.isKeyAvailable(key),
          quotaState: quotaPersistenceHealthy ? (quotaWindow?.state || 'open') : 'closed',
          quotaNextProbeAt: quotaWindow?.nextProbeAt || 0,
          keyCooldownUntil: state.badUntil,
          keyCooldownReason: activeCooldownReason(state, now) || 'key_cooldown',
          modelCooldownUntil,
          modelCooldownReason: modelCooldownUntil > now ? 'model_cooldown' : '',
          rateLimitUntil: rateLimit.retryAt,
          vendorBlockedReason,
          pricingBlockedReason: checkVendorPricingCoverage(vendor, vendorConfig, model),
          vendorCapacityFull: wideCap !== Infinity && activeForVendor >= wideCap,
          keyCapacityFull: state.inflight >= state.cap,
          modelCapacityFull: policy
            ? (modelInflight.get(normalizedModel) || 0) >= policy.maxInflight
            : false,
          latestValidatedOutcome: qualification?.latestValidatedOutcome,
          failureClass: qualification?.failureClass || '',
          lastValidatedAt: qualification?.lastValidatedAt || 0,
          qualificationNextProbeAt: qualification?.nextProbeAt || 0,
        }, now);

        const modelEntry = models.get(normalizedModel) || { id: model, records: [] };
        modelEntry.records.push({ eligibility });
        if (!models.has(normalizedModel)) models.set(normalizedModel, modelEntry);
      }
    }

    return [...models.entries()]
      .map(([normalizedModel, modelEntry]) => {
        const qualification = summarizeEligibility(modelEntry.records, now);
        return {
          id: modelEntry.id,
          lower: normalizedModel,
          total_keys: qualification.configured,
          eligible_keys: qualification.dispatchable,
          ready_keys: qualification.available,
          dead_keys: modelEntry.records
            .filter((record) => record.eligibility.reason === 'model_cooldown').length,
          cooldown_keys: qualification.counts.cooldown,
          health: qualification.health,
          qualification,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function buildModelInventory(now = Date.now()) {
    const { vendors } = getRuntime();
    const inventory = new Map();

    for (const [vendor, vendorConfig] of Object.entries(vendors)) {
      for (const route of vendorConfig.routes || []) {
        for (const health of collectVendorModelHealth(vendor, now, route.format)) {
          let model = inventory.get(health.lower);
          if (!model) {
            model = {
              id: health.id,
              object: 'model',
              owned_by: 'tomato-tap',
              health: 'unavailable',
              routes: [],
            };
            inventory.set(health.lower, model);
          }

          const anthropic = route.format === 'anthropic';
          model.routes.push({
            vendor,
            route_prefix: route.prefix,
            models_url: `${route.prefix}/models`,
            chat_completion_url: anthropic
              ? `${route.prefix}/v1/messages`
              : `${route.prefix}/chat/completions`,
            health: health.health,
            total_keys: health.total_keys,
            eligible_keys: health.eligible_keys,
            ready_keys: health.ready_keys,
            qualification: health.qualification,
          });
          if (model.health !== 'available' && health.health === 'available') {
            model.health = 'available';
          } else if (model.health === 'unavailable' && health.health === 'congested') {
            model.health = 'congested';
          }
        }
      }
    }

    return [...inventory.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  function buildLogicalRoutePlan({
    model,
    taskName = '',
    excludedVendors = new Set(),
    now = Date.now(),
    includeEligibilityDetails = true,
    includeSelection = true,
  } = {}) {
    const { modelPolicy } = getRuntime();
    const request = resolveLogicalRequest(modelPolicy, model, taskName);
    if (!request) return null;

    const deployments = logicalDeployments.list(request, now, { includeLogicalAdmission: true })
      .filter((deployment) => !excludedVendors.has(deployment.vendor.toLowerCase()))
      .filter((deployment) => deploymentMatchesRequest(request, deployment));
    const qualification = summarizeEligibility(deployments, now);
    const selected = includeSelection && logicalScheduler ? selectLogicalCandidate({
      scheduler: logicalScheduler,
      request,
      deployments,
      now,
      sessionId: '',
      avoidModel: '',
      excludedPairs: new Set(),
      remainingMs: request.deadlineMs,
      modelAttemptCounts: new Map(),
    }) : null;
    const candidates = request.candidates.map((candidate, index) => {
      const physicalPolicy = realModelPolicy(modelPolicy, candidate);
      const records = deployments.filter(
        (deployment) => deployment.model.toLowerCase() === candidate.toLowerCase(),
      );
      const summary = summarizeEligibility(records, now);
      const reasons = {};
      for (const deployment of records) {
        const reason = deployment.eligibility?.reason || 'unknown';
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      return {
        model: candidate,
        order: index + 1,
        quality_tier: physicalPolicy?.qualityTier || null,
        capabilities: [...(physicalPolicy?.capabilities || [])],
        thinking_adapter: physicalPolicy?.thinkingAdapter || null,
        max_tokens_multiplier: physicalPolicy?.maxTokensMultiplier || 1,
        health: summary.health,
        configured_deployments: summary.configured,
        dispatchable_deployments: summary.dispatchable,
        available_deployments: summary.available,
        states: summary.counts,
        reasons,
        providers: [...new Set(records.map((deployment) => deployment.vendor))].sort(),
        next_recovery_at: summary.next_recovery_at,
      };
    });

    const plan = {
      object: 'tomato_tap.route_plan',
      logical_model: request.logicalModel,
      requested_task: request.taskName || null,
      health: qualification.health,
      dispatchable: qualification.dispatchable > 0,
      available: qualification.available > 0,
      strategy: {
        candidate: request.candidateStrategy,
        max_attempts: request.maxAttempts,
        deadline_ms: request.deadlineMs,
        admission_wait_ms: request.logicalAdmissionWaitMs,
        max_inflight: request.maxInflight,
        session_affinity: request.sessionAffinity,
        prefer_different_from_previous: request.preferDifferentFromPrevious,
        request: requestPolicyJSON(request.requestPolicy),
      },
      requirements: {
        capabilities: [...request.requiredCapabilities],
        quality_tier: request.qualityTier || null,
        allow_weak_fallback: request.allowWeakFallback,
        protected: request.protected,
        min_ready_slots: request.minReadySlots,
      },
      qualification: {
        state: qualification.state,
        configured_deployments: qualification.configured,
        dispatchable_deployments: qualification.dispatchable,
        available_deployments: qualification.available,
        counts: qualification.counts,
        next_recovery_at: qualification.next_recovery_at,
      },
      candidates,
      selection: selected ? {
        model: selected.model,
        deployment: selected.deploymentId,
        vendor: selected.vendor,
        state: selected.eligibility?.state || null,
        timeout_ms: selected.timeoutMs,
        provider_request_policy: requestPolicyJSON(selected.requestPolicy),
        score: Number.isFinite(selected.score)
          ? Number(selected.score.toPrecision(6))
          : null,
        decision_basis: request.candidateStrategy === 'ordered'
          ? 'first qualified candidate in configured order'
          : 'highest qualification, health, free capacity, success rate, and latency score',
      } : null,
      excluded_vendors: [...excludedVendors],
      generated_at: new Date(now).toISOString(),
    };

    if (includeEligibilityDetails) {
      plan.deployments = deployments.map((deployment) => ({
        model: deployment.model,
        deployment: deployment.deploymentId,
        vendor: deployment.vendor,
        state: deployment.eligibility.state,
        reason: deployment.eligibility.reason,
        dispatchable: deployment.eligibility.dispatchable,
        available: deployment.eligibility.available,
        retryable: deployment.eligibility.retryable,
        recovery_at: deployment.eligibility.recovery_at,
        key_inflight: deployment.inflight,
        key_cap: deployment.cap,
        model_inflight: deployment.modelInflight,
        model_cap: deployment.modelMaxInflight,
        request_policy: requestPolicyJSON(deployment.requestPolicy),
      }));
    }
    return plan;
  }

  function buildLogicalModelInventory({
    taskName = '',
    excludedVendors = new Set(),
    now = Date.now(),
    includeEligibilityDetails = false,
  } = {}) {
    const { modelPolicy } = getRuntime();
    const inventory = [];

    for (const logicalModel of modelPolicy.logicalModels.values()) {
      let plan;
      try {
        plan = buildLogicalRoutePlan({
          model: logicalModel.name,
          taskName,
          excludedVendors,
          now,
          includeEligibilityDetails,
          includeSelection: false,
        });
      } catch {
        continue;
      }
      if (!plan) continue;
      const qualification = plan.qualification;
      const health = plan.health;
      const entry = {
        id: logicalModel.name,
        object: 'model',
        owned_by: 'tomato-tap-logical',
        health,
        requested_task: taskName || null,
        candidate_models: plan.candidates.map((candidate) => candidate.model),
        candidate_strategy: plan.strategy.candidate,
        request_policy: plan.strategy.request,
        eligible_deployments: qualification.configured_deployments,
        ready_deployments: qualification.counts.ready,
        congested_deployments: qualification.counts.congested,
        cooldown_deployments: qualification.counts.cooldown,
        probing_deployments: qualification.counts.probing,
        unhealthy_deployments: qualification.counts.unhealthy,
        qualification: {
          state: qualification.state,
          configured_deployments: qualification.configured_deployments,
          dispatchable_deployments: qualification.dispatchable_deployments,
          available_deployments: qualification.available_deployments,
          counts: qualification.counts,
          next_recovery_at: qualification.next_recovery_at,
        },
        routes: [{
          vendor: 'logical',
          route_prefix: '/oa/v1',
          models_url: '/oa/v1/models',
          chat_completion_url: '/oa/v1/chat/completions',
          health,
        }],
      };

      if (includeEligibilityDetails) {
        entry.candidate_eligibility = plan.deployments;
      }

      inventory.push(entry);
    }

    return inventory.sort((left, right) => left.id.localeCompare(right.id));
  }

  return Object.freeze({
    collectVendorModelHealth,
    buildModelInventory,
    buildLogicalModelInventory,
    buildLogicalRoutePlan,
  });
}
