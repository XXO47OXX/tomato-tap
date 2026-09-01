export function createRequestAccounting({
  ledger,
  dashboard,
  pricing,
  budgetManager,
  extractUsage,
  getVendors,
  providerByKey = () => '',
  providerByDeployment = () => '',
  logger = console,
} = {}) {
  if (!ledger?.append || !dashboard?.record) {
    throw new Error('request-accounting: ledger and dashboard are required');
  }
  if (!pricing?.snapshot || typeof extractUsage !== 'function' || typeof getVendors !== 'function') {
    throw new Error('request-accounting: pricing, extractUsage, and getVendors are required');
  }

  const {
    budget,
    vendorSpendToday,
    settings,
    modelMultiplier,
    saveBudget,
    resetDailyVendorSpend,
    recordVendorSpend,
    recordVendorCnySpend,
    estimateVendorCny,
    estimateRequestReserveCny,
  } = budgetManager;

  function appendUsage(entry) {
    const provider = entry?.provider
      || (entry?.key ? providerByKey(entry.key) : '')
      || (entry?.deployment ? providerByDeployment(entry.deployment) : '')
      || entry?.vendor
      || 'unknown';
    const attributed = entry && typeof entry === 'object' ? { ...entry, provider } : entry;
    const enriched = attributed?.model && !attributed.pricing
      ? {
          ...attributed,
          pricing: pricing.snapshot(attributed.model, {
            at: new Date(attributed.ts || Date.now()),
          }),
        }
      : attributed;
    ledger.append(enriched);
    dashboard.record(enriched);
  }

  function recordLogicalUsage({
    id,
    requestedModel,
    resolvedModel,
    result,
    keyPick,
    attempts,
    requestBody,
    routePrefix,
  }) {
    const usage = responseUsage(result);
    const credits = creditsFor(resolvedModel, usage);
    const vendorCny = vendorCost(keyPick.vendor, resolvedModel, usage, requestBody);
    recordCharge(keyPick.vendor, resolvedModel, credits, vendorCny);
    appendUsage({
      ts: new Date().toISOString(),
      id,
      event: 'logical_terminal',
      valid: true,
      terminal: true,
      status: result.status,
      model: resolvedModel,
      requested_model: requestedModel,
      input: usage.input,
      output: usage.output,
      input_cached: usage.inputCached,
      input_miss: usage.inputMiss,
      credits,
      vendor: keyPick.vendor,
      deployment: keyPick.deploymentId,
      vendor_cny: vendorCny,
      attempt: attempts,
      attempts,
      route: routePrefix || null,
    });
  }

  function recordLogicalAttempt({
    id,
    requestedModel,
    resolvedModel,
    result,
    keyPick,
    attempt,
    requestBody,
    routePrefix,
    failureClass,
  }) {
    const usage = responseUsage(result);
    const hasTokenUsage = usage.input + usage.output > 0;
    const successfulHttpResponse = result.status >= 200 && result.status < 300;
    const credits = hasTokenUsage ? creditsFor(resolvedModel, usage) : 0;
    const vendorCny = hasTokenUsage || successfulHttpResponse
      ? vendorCost(keyPick.vendor, resolvedModel, usage, requestBody)
      : 0;
    recordCharge(keyPick.vendor, resolvedModel, credits, vendorCny);
    appendUsage({
      ts: new Date().toISOString(),
      id: `${id}:attempt:${attempt}`,
      request_id: id,
      event: 'logical_attempt',
      valid: false,
      terminal: false,
      error: true,
      status: result.status,
      failure_class: failureClass || 'invalid_response',
      model: resolvedModel,
      requested_model: requestedModel,
      input: usage.input,
      output: usage.output,
      input_cached: usage.inputCached,
      input_miss: usage.inputMiss,
      credits,
      vendor: keyPick.vendor,
      deployment: keyPick.deploymentId,
      vendor_cny: vendorCny,
      billable: credits > 0 || vendorCny > 0,
      usage_missing: !hasTokenUsage,
      attempt,
      attempts: attempt,
      route: routePrefix || null,
    });
  }

  function recordOrdinaryTerminal({
    clientReq,
    id,
    url,
    reqBuf,
    requestedModel,
    keyPick,
    result,
    attempt,
    route,
  }) {
    const status = result.status;
    if (status < 200 || status >= 300) {
      appendUsage({
        ts: new Date().toISOString(),
        id,
        status,
        model: requestedModel,
        error: true,
        key: keyPick.name,
        vendor: keyPick.vendor,
        attempts: attempt + 1,
        route: route.prefix,
      });
      logger.log?.(
        `[${id}] ${clientReq.method} ${url} -> ${status} key=${keyPick.name} `
        + `attempts=${attempt + 1} (no charge)`,
      );
      return;
    }

    const usage = responseUsage(result);
    const multiplier = modelMultiplier(requestedModel);
    const credits = Math.round(
      (usage.input + usage.output) * multiplier * settings.offPeakMultiplier,
    );
    const vendorCny = vendorCost(keyPick.vendor, requestedModel, usage, reqBuf);
    recordCharge(keyPick.vendor, requestedModel || 'unknown', credits, vendorCny);
    appendUsage({
      ts: new Date().toISOString(),
      id,
      status,
      model: requestedModel,
      input: usage.input,
      output: usage.output,
      input_cached: usage.inputCached,
      input_miss: usage.inputMiss,
      mult: multiplier,
      offpeak: settings.offPeakMultiplier,
      credits,
      used_after: budget.used,
      total: budget.total,
      vendor: keyPick.vendor,
      vendor_cny: vendorCny,
      vendor_spend_cny_after: Number(vendorSpendToday[keyPick.vendor]?.cny || 0),
      key: keyPick.name,
      attempts: attempt + 1,
      route: route.prefix,
    });
    logger.log?.(
      `[${id}] ${clientReq.method} ${url} -> ${status} key=${keyPick.name} `
      + `attempts=${attempt + 1} model=${requestedModel || '?'} `
      + `in=${usage.input} cached=${usage.inputCached} miss=${usage.inputMiss} `
      + `out=${usage.output} credits=+${credits} vendor_cny=+${vendorCny.toFixed(6)} `
      + `used=${budget.used}/${budget.total}`,
    );
  }

  function recordOrdinaryExhausted({
    clientReq,
    id,
    url,
    requestedModel,
    lastResult,
    lastKey,
    route,
    attempts,
  }) {
    appendUsage({
      ts: new Date().toISOString(),
      id,
      status: lastResult.status,
      model: requestedModel,
      error: true,
      key: lastKey?.name || '?',
      vendor: lastKey?.vendor || null,
      attempts,
      exhausted: true,
      route: route.prefix,
    });
    logger.log?.(
      `[${id}] ${clientReq.method} ${url} -> ${lastResult.status} `
      + `key=${lastKey?.name || '?'} attempts=${attempts} ALL_RETRYABLE_FAILURES`,
    );
  }

  function responseUsage(result) {
    const contentType = String(result.headers?.['content-type'] || '');
    return extractUsage(result.body, contentType);
  }

  function creditsFor(model, usage) {
    return Math.round(
      (usage.input + usage.output) * modelMultiplier(model) * settings.offPeakMultiplier,
    );
  }

  function vendorCost(vendor, model, usage, requestBody) {
    const vendorConfig = getVendors()[vendor];
    let cost = estimateVendorCny(vendorConfig, model, usage);
    if (cost <= 0 && vendorConfig?.constraints?.dailyCnyCap) {
      cost = estimateRequestReserveCny(vendorConfig, model, requestBody);
    }
    return cost;
  }

  function recordCharge(vendor, model, credits, vendorCny) {
    if (credits <= 0 && vendorCny <= 0) return;
    budget.used += credits;
    budget.by_model[model] = (budget.by_model[model] || 0) + credits;
    resetDailyVendorSpend(Date.now());
    recordVendorSpend(vendor, credits);
    recordVendorCnySpend(vendor, vendorCny);
    budget.vendor_spend_today = vendorSpendToday;
    saveBudget();
  }

  return Object.freeze({
    appendUsage,
    recordLogicalAttempt,
    recordLogicalUsage,
    recordOrdinaryTerminal,
    recordOrdinaryExhausted,
  });
}
