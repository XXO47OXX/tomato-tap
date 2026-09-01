import {
  filterModelInventory,
  modelListPayload,
  parseModelQuery,
} from './model-api.mjs';

export function createControlPlaneHandler({
  getStatusPayload,
  usageDashboard,
  usageHistory,
  modelPricing,
  getRealModels,
  buildModelInventory,
  buildLogicalModelInventory,
  buildLogicalRoutePlan,
  adminConsole,
}) {
  async function handleGlobal(clientReq, clientRes, { pathname, parsedUrl }) {
    if (adminConsole && await adminConsole.handle(clientReq, clientRes, { pathname, parsedUrl })) {
      return true;
    }
    if (pathname === '/healthz' || pathname === '/healthz/') {
      if (clientReq.method !== 'GET') {
        methodNotAllowed(clientRes);
        return true;
      }
      sendJson(clientRes, 200, {
        object: 'tomato_tap.health',
        status: 'ok',
        service: 'tomato-tap',
        now: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store' } });
      return true;
    }

    if (pathname === '/readyz' || pathname === '/readyz/') {
      if (clientReq.method !== 'GET') {
        methodNotAllowed(clientRes);
        return true;
      }
      const query = parseModelQuery(parsedUrl.searchParams);
      let readinessMode;
      try {
        readinessMode = parseReadinessMode(parsedUrl.searchParams);
      } catch (error) {
        sendJson(clientRes, 400, {
          error: { type: 'invalid_readiness_mode', message: error.message },
        }, { headers: { 'cache-control': 'no-store' } });
        return true;
      }
      if (query.modelFilter) {
        let plan;
        try {
          plan = buildLogicalRoutePlan({
            model: query.modelFilter,
            taskName: query.taskName,
            excludedVendors: query.excludedVendors,
            includeEligibilityDetails: false,
            includeSelection: false,
          });
        } catch (error) {
          sendJson(clientRes, 400, {
            error: { type: 'invalid_route_plan', message: error.message },
          }, { headers: { 'cache-control': 'no-store' } });
          return true;
        }
        if (!plan) {
          sendJson(clientRes, 404, {
            error: { type: 'unknown_logical_model', message: `unknown logical model ${query.modelFilter}` },
          }, { headers: { 'cache-control': 'no-store' } });
          return true;
        }
        const ready = readinessMode === 'available' ? plan.available : plan.dispatchable;
        sendJson(clientRes, ready ? 200 : 503, {
          object: 'tomato_tap.readiness',
          status: ready ? 'ready' : 'not_ready',
          mode: readinessMode,
          logical_model: plan.logical_model,
          requested_task: plan.requested_task,
          health: plan.health,
          dispatchable: plan.dispatchable,
          available: plan.available,
          qualification: plan.qualification,
        }, { headers: { 'cache-control': 'no-store' } });
        return true;
      }

      const logicalModels = buildLogicalModelInventory({
        taskName: query.taskName,
        excludedVendors: query.excludedVendors,
      });
      const ready = logicalModels.filter(
        (model) => readinessMode === 'available'
          ? model.qualification.available_deployments > 0
          : model.qualification.dispatchable_deployments > 0,
      );
      const dispatchable = logicalModels.filter(
        (model) => model.qualification.dispatchable_deployments > 0,
      );
      const available = logicalModels.filter(
        (model) => model.qualification.available_deployments > 0,
      );
      sendJson(clientRes, ready.length > 0 ? 200 : 503, {
        object: 'tomato_tap.readiness',
        status: ready.length > 0 ? 'ready' : 'not_ready',
        mode: readinessMode,
        dispatchable_logical_models: dispatchable.map((model) => model.id),
        available_logical_models: available.map((model) => model.id),
        configured_logical_models: logicalModels.length,
        requested_task: query.taskName || null,
      }, { headers: { 'cache-control': 'no-store' } });
      return true;
    }

    if (pathname === '/__route/plan' || pathname === '/__route/plan/') {
      if (clientReq.method !== 'GET') {
        methodNotAllowed(clientRes);
        return true;
      }
      const query = parseModelQuery(parsedUrl.searchParams);
      if (!query.modelFilter) {
        sendJson(clientRes, 400, {
          error: { type: 'invalid_route_plan', message: 'model query parameter is required' },
        });
        return true;
      }
      let plan;
      try {
        plan = buildLogicalRoutePlan({
          model: query.modelFilter,
          taskName: query.taskName,
          excludedVendors: query.excludedVendors,
          includeEligibilityDetails: true,
        });
      } catch (error) {
        sendJson(clientRes, 400, {
          error: { type: 'invalid_route_plan', message: error.message },
        });
        return true;
      }
      if (!plan) {
        sendJson(clientRes, 404, {
          error: { type: 'unknown_logical_model', message: `unknown logical model ${query.modelFilter}` },
        });
        return true;
      }
      sendJson(clientRes, 200, plan, {
        pretty: true,
        headers: { 'cache-control': 'no-store' },
      });
      return true;
    }

    if (pathname === '/__status') {
      if (clientReq.method !== 'GET') {
        sendJson(clientRes, 405, {
          error: { type: 'method_not_allowed', message: 'GET required' },
        }, { headers: { allow: 'GET' } });
        return true;
      }
      sendJson(clientRes, 200, getStatusPayload(), { pretty: true });
      return true;
    }

    if (pathname === '/__usage' || pathname === '/__usage/') {
      if (clientReq.method !== 'GET') {
        sendJson(clientRes, 405, {
          error: { type: 'method_not_allowed', message: 'GET required' },
        }, { headers: { allow: 'GET' } });
        return true;
      }
      await handleUsage(clientRes, parsedUrl.searchParams);
      return true;
    }

    if (pathname === '/models' || pathname === '/models/') {
      if (clientReq.method !== 'GET') {
        sendJson(clientRes, 405, {
          error: { type: 'method_not_allowed', message: 'GET required' },
        }, { headers: { allow: 'GET' } });
        return true;
      }
      const query = parseModelQuery(parsedUrl.searchParams);
      const raw = [
        ...buildModelInventory(),
        ...buildLogicalModelInventory({
          taskName: query.taskName,
          excludedVendors: query.excludedVendors,
          includeEligibilityDetails: query.includeEligibilityDetails && !!query.modelFilter,
        }),
      ];
      sendJson(clientRes, 200, modelListPayload(filterModelInventory(raw, query), query), {
        pretty: true,
      });
      return true;
    }
    return false;
  }

  function handleRouteDiscovery(clientReq, clientRes, {
    pathname,
    parsedUrl,
    url,
    vendor,
    route,
  }) {
    if (clientReq.method === 'GET'
        && (pathname === route.prefix || pathname === `${route.prefix}/`)) {
      sendJson(clientRes, 200, { status: 'ok', vendor, route: route.prefix, path: url });
      return true;
    }

    if (clientReq.method !== 'GET'
        || (pathname !== `${route.prefix}/models` && pathname !== `${route.prefix}/models/`)) {
      return false;
    }

    const now = Date.now();
    const query = parseModelQuery(parsedUrl.searchParams);
    const entries = [];
    const seen = new Set();
    for (const model of buildModelInventory(now)) {
      const matchingRoutes = model.routes.filter((candidateRoute) => (
        candidateRoute.vendor === vendor && candidateRoute.route_prefix === route.prefix
      ));
      if (matchingRoutes.length === 0) continue;
      seen.add(model.id.toLowerCase());
      entries.push({ ...model, routes: matchingRoutes, created: Math.floor(now / 1000) });
    }
    for (const logical of buildLogicalModelInventory({
      taskName: query.taskName,
      excludedVendors: query.excludedVendors,
      now,
      includeEligibilityDetails: query.includeEligibilityDetails && !!query.modelFilter,
    })) {
      if (seen.has(logical.id.toLowerCase())) continue;
      seen.add(logical.id.toLowerCase());
      entries.push({ ...logical, created: Math.floor(now / 1000) });
    }
    sendJson(
      clientRes,
      200,
      modelListPayload(filterModelInventory(entries, query), query),
    );
    return true;
  }

  async function handleUsage(clientRes, query) {
    const formatJson = query.get('format') === 'json';
    const view = (query.get('view') || '').trim();
    const from = (query.get('from') || '').trim();
    const to = (query.get('to') || '').trim();
    const period = (query.get('period') || '').trim();

    if (view === 'prices') {
      const configuredModels = [...new Set([
        ...buildModelInventory().map((model) => model.id),
        ...getRealModels().map((model) => model.name),
      ])].sort((left, right) => left.localeCompare(right));
      if (formatJson) {
        sendJson(clientRes, 200, {
          object: 'tomato_tap.model_prices',
          coverage: modelPricing.stats(configuredModels),
          data: configuredModels.map((model) => ({
            model,
            price: modelPricing.resolve(model, { at: new Date() }),
          })),
        }, { pretty: true });
        return;
      }
      sendHtml(clientRes, usageDashboard.buildPriceHtml(configuredModels, new Date()));
      return;
    }

    if (period || from || to) {
      await usageHistory.sync();
      const params = {
        period,
        from,
        to,
        granularity: query.get('granularity') || 'day',
        dimension: query.get('dimension') || 'date',
        route: (query.get('route') || '').trim(),
        vendor: (query.get('vendor') || '').trim(),
        provider: (query.get('provider') || '').trim(),
        model: (query.get('model') || '').trim(),
      };
      let result;
      try {
        result = usageHistory.query(params);
      } catch (error) {
        sendJson(clientRes, 400, {
          error: { type: 'invalid_usage_range', message: error.message },
        });
        return;
      }
      if (formatJson) {
        sendJson(clientRes, 200, { object: 'tomato_tap.usage_range', ...result }, { pretty: true });
        return;
      }
      sendHtml(clientRes, usageHistory.buildHtml(result, params, new Date()));
      return;
    }

    if (formatJson) {
      sendJson(clientRes, 200, {
        object: 'tomato_tap.usage_today',
        ...usageDashboard.snapshot(),
      }, { pretty: true });
      return;
    }
    sendHtml(clientRes, usageDashboard.buildHtml(new Date()));
  }

  return Object.freeze({ handleGlobal, handleRouteDiscovery });
}

function sendJson(response, status, payload, { pretty = false, headers = {} } = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload, null, pretty ? 2 : 0));
}

function sendHtml(response, html) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

function methodNotAllowed(response) {
  sendJson(response, 405, {
    error: { type: 'method_not_allowed', message: 'GET required' },
  }, { headers: { allow: 'GET' } });
}

function parseReadinessMode(searchParams) {
  const mode = String(searchParams?.get?.('mode') || 'dispatchable').trim().toLowerCase();
  if (mode === 'dispatchable' || mode === 'available') return mode;
  throw new Error('mode must be dispatchable or available');
}
