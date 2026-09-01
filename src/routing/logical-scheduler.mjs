export function pairId(deploymentId, model) {
  return `${deploymentId}\u0000${String(model || '').toLowerCase()}`;
}

export function deploymentMatchesRequest(request, deployment) {
  const modelLower = String(deployment.model || '').toLowerCase();
  const allowed = request.candidates.some((candidate) => candidate.toLowerCase() === modelLower);
  if (!allowed) return false;
  if (request.requiredCapabilities.some(
    (capability) => !deployment.capabilities.includes(capability),
  )) return false;
  if (request.qualityTier
      && deployment.qualityTier !== request.qualityTier
      && !request.allowWeakFallback) return false;
  return true;
}

export function selectLogicalCandidate({
  scheduler,
  request,
  deployments,
  now,
  sessionId,
  avoidModel,
  excludedPairs,
  remainingMs,
  modelAttemptCounts = new Map(),
}) {
  const allPairs = deployments.map((deployment) => ({
    model: deployment.model.toLowerCase(),
    id: pairId(deployment.deploymentId, deployment.model),
  }));
  const selections = [];
  for (const model of request.candidates) {
    const modelLower = model.toLowerCase();
    const modelExcluded = new Set(excludedPairs);
    for (const pair of allPairs) {
      if (pair.model !== modelLower) modelExcluded.add(pair.id);
    }
    const selection = scheduler.select({
      request,
      deployments,
      now,
      sessionId,
      avoidModel,
      excludedPairs: modelExcluded,
      remainingMs,
    });
    if (selection) {
      selections.push({
        selection,
        attempts: modelAttemptCounts.get(modelLower) || 0,
      });
    }
  }
  if (selections.length === 0) return null;

  const highestQualification = Math.max(
    ...selections.map((entry) => eligibilityRank(entry.selection.eligibility)),
  );
  const qualified = selections.filter((entry) => (
    eligibilityRank(entry.selection.eligibility) === highestQualification
  ));
  if (request.candidateStrategy === 'adaptive') {
    let best = qualified[0];
    for (const entry of qualified.slice(1)) {
      if (entry.selection.score > best.selection.score) best = entry;
    }
    return best.selection;
  }
  const minimumAttempts = Math.min(...qualified.map((entry) => entry.attempts));
  const currentRound = qualified.filter((entry) => entry.attempts === minimumAttempts);
  if (request.candidateStrategy === 'ordered') return currentRound[0].selection;

  let best = currentRound[0];
  for (const entry of currentRound.slice(1)) {
    if (entry.selection.score > best.selection.score) best = entry;
  }
  return best.selection;
}

export function createLogicalScheduler({ historySize = 64 } = {}) {
  if (!Number.isInteger(historySize) || historySize < 1) {
    throw new Error('historySize must be a positive integer');
  }

  const stats = new Map();
  const sessions = new Map();
  const activeByLogical = new Map();
  const protectedDemand = new Map();

  function enter(request) {
    const active = activeByLogical.get(request.logicalModel) || 0;
    if (active >= request.maxInflight) return null;
    activeByLogical.set(request.logicalModel, active + 1);

    const demandKey = request.taskName || request.logicalModel;
    if (request.protected && request.minReadySlots > 0) {
      protectedDemand.set(
        demandKey,
        (protectedDemand.get(demandKey) || 0) + request.minReadySlots,
      );
    }

    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        const nextActive = Math.max(0, (activeByLogical.get(request.logicalModel) || 1) - 1);
        if (nextActive === 0) activeByLogical.delete(request.logicalModel);
        else activeByLogical.set(request.logicalModel, nextActive);

        if (request.protected && request.minReadySlots > 0) {
          const nextDemand = Math.max(
            0,
            (protectedDemand.get(demandKey) || request.minReadySlots) - request.minReadySlots,
          );
          if (nextDemand === 0) protectedDemand.delete(demandKey);
          else protectedDemand.set(demandKey, nextDemand);
        }
      },
    });
  }

  function record({
    deploymentId,
    model,
    valid,
    latencyMs,
    firstByteMs,
    failureClass,
    sessionId,
    now = Date.now(),
  }) {
    const id = pairId(deploymentId, model);
    const state = stats.get(id) || { outcomes: [], latencies: [], firstBytes: [] };
    state.outcomes.push(valid ? 1 : 0);
    state.latencies.push(Math.max(0, Number(latencyMs) || 0));
    state.firstBytes.push(Math.max(0, Number(firstByteMs) || 0));
    state.failureClass = failureClass || '';
    state.lastUpdated = now;
    trim(state.outcomes, historySize);
    trim(state.latencies, historySize);
    trim(state.firstBytes, historySize);
    stats.set(id, state);

    if (valid && sessionId) {
      sessions.set(sessionId, {
        model: String(model || '').toLowerCase(),
        expiresAt: now + 10 * 60 * 1000,
      });
    }
  }

  function select({
    request,
    deployments,
    now = Date.now(),
    sessionId = '',
    avoidModel = '',
    excludedPairs = new Set(),
    remainingMs = request.deadlineMs,
  }) {
    const affinity = request.sessionAffinity ? sessions.get(sessionId) : null;
    const reservedStrongSlots = [...protectedDemand.values()].reduce((sum, value) => sum + value, 0);
    const healthyStrongSlots = freeStrongSlots(deployments, now);
    let best = null;

    for (const deployment of deployments) {
      const modelLower = String(deployment.model || '').toLowerCase();
      if (!deploymentMatchesRequest(request, deployment)) continue;
      if (deployment.eligibility && deployment.eligibility.dispatchable !== true) continue;
      if (deployment.inflight >= deployment.cap) continue;
      if (now < (deployment.badUntil || 0) || now < (deployment.deadUntil || 0)) continue;
      if (deployment.modelInflight >= deployment.modelMaxInflight) continue;
      if (excludedPairs.has(pairId(deployment.deploymentId, deployment.model))) continue;
      if (reservedStrongSlots > 0
          && !request.protected
          && deployment.qualityTier === 'strong'
          && healthyStrongSlots <= reservedStrongSlots) continue;

      const state = stats.get(pairId(deployment.deploymentId, deployment.model));
      const success = state?.outcomes.length
        ? state.outcomes.reduce((sum, outcome) => sum + outcome, 0) / state.outcomes.length
        : 1;
      const p95 = percentile(state?.latencies || [], 0.95)
        || deployment.initialLatencyMs
        || 10000;
      const freeRatio = (deployment.cap - deployment.inflight) / deployment.cap;
      const affinityBoost = affinity
        && affinity.expiresAt > now
        && affinity.model === modelLower
        ? 1.4
        : 1;
      const avoidPenalty = avoidModel && modelLower === avoidModel.toLowerCase() ? 0.4 : 1;
      const qualificationBoost = eligibilityWeight(deployment.eligibility);
      const score = (deployment.baseWeight || 1)
        * freeRatio
        * Math.max(0.05, success * success)
        * qualificationBoost
        * affinityBoost
        * avoidPenalty
        / Math.max(1, p95);
      const dynamicTimeout = Math.min(
        deployment.totalTimeoutMs,
        Math.max(deployment.firstByteTimeoutMs, Math.ceil(p95 * 1.5)),
      );
      const candidate = {
        ...deployment,
        candidateModel: deployment.model,
        score,
        timeoutMs: Math.max(1, Math.min(dynamicTimeout, remainingMs)),
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
    return best;
  }

  function snapshot(now = Date.now()) {
    for (const [sessionId, value] of sessions) {
      if (value.expiresAt <= now) sessions.delete(sessionId);
    }
    return {
      pairs: [...stats.entries()].map(([id, value]) => [id, structuredClone(value)]),
      sessions: [...sessions.entries()].map(([id, value]) => [id, { ...value }]),
      activeByLogical: Object.fromEntries(activeByLogical),
      protectedDemand: Object.fromEntries(protectedDemand),
    };
  }

  return Object.freeze({ enter, select, record, snapshot });
}

function trim(values, maxLength) {
  while (values.length > maxLength) values.shift();
}

function eligibilityRank(eligibility) {
  if (!eligibility) return 2;
  if (eligibility.state === 'ready') return 3;
  if (eligibility.state === 'probing') return 2;
  if (eligibility.state === 'unhealthy') return 1;
  return 0;
}

function eligibilityWeight(eligibility) {
  const rank = eligibilityRank(eligibility);
  if (rank >= 3) return 4;
  if (rank === 2) return 1;
  if (rank === 1) return 0.1;
  return 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

function freeStrongSlots(deployments, now) {
  const keys = new Map();
  const models = new Map();
  for (const deployment of deployments) {
    if (deployment.qualityTier !== 'strong') continue;
    if (deployment.eligibility && deployment.eligibility.dispatchable !== true) continue;
    if (now < (deployment.badUntil || 0) || now < (deployment.deadUntil || 0)) continue;
    const keyFree = Math.max(0, deployment.cap - deployment.inflight);
    const modelFree = Math.max(0, deployment.modelMaxInflight - deployment.modelInflight);
    if (keyFree === 0 || modelFree === 0) continue;
    const keyId = deployment.keyIndex == null
      ? `deployment:${deployment.deploymentId}`
      : `key:${deployment.keyIndex}`;
    const model = String(deployment.model || '').toLowerCase();
    const key = keys.get(keyId) || { capacity: keyFree, models: new Set() };
    key.capacity = Math.max(key.capacity, keyFree);
    key.models.add(model);
    keys.set(keyId, key);
    models.set(model, Math.max(models.get(model) || 0, modelFree));
  }
  return maximumSlotFlow(keys, models);
}

function maximumSlotFlow(keys, models) {
  const source = 'source';
  const sink = 'sink';
  const residual = new Map();
  const addEdge = (from, to, capacity) => {
    if (!residual.has(from)) residual.set(from, new Map());
    if (!residual.has(to)) residual.set(to, new Map());
    residual.get(from).set(to, (residual.get(from).get(to) || 0) + capacity);
    if (!residual.get(to).has(from)) residual.get(to).set(from, 0);
  };
  for (const [keyId, key] of keys) {
    const keyNode = `k:${keyId}`;
    addEdge(source, keyNode, key.capacity);
    for (const model of key.models) addEdge(keyNode, `m:${model}`, key.capacity);
  }
  for (const [model, capacity] of models) addEdge(`m:${model}`, sink, capacity);

  let total = 0;
  while (true) {
    const parent = new Map([[source, null]]);
    const queue = [source];
    while (queue.length > 0 && !parent.has(sink)) {
      const current = queue.shift();
      for (const [next, capacity] of residual.get(current) || []) {
        if (capacity <= 0 || parent.has(next)) continue;
        parent.set(next, current);
        queue.push(next);
      }
    }
    if (!parent.has(sink)) break;
    let amount = Infinity;
    for (let node = sink; node !== source; node = parent.get(node)) {
      amount = Math.min(amount, residual.get(parent.get(node)).get(node));
    }
    for (let node = sink; node !== source; node = parent.get(node)) {
      const previous = parent.get(node);
      residual.get(previous).set(node, residual.get(previous).get(node) - amount);
      residual.get(node).set(previous, residual.get(node).get(previous) + amount);
    }
    total += amount;
  }
  return total;
}
