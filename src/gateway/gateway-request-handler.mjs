import { rejectByPath } from './http-response.mjs';
import { evaluateRouteRequest } from './gateway-policy.mjs';
import { readRequestBody, RequestBodyError } from './request-reader.mjs';

export function createGatewayRequestHandler({
  port,
  controlPlane,
  routeForPath,
  getVendors,
  runtimeGeneration,
  inWindow,
  windowStartUtcHour,
  windowEndUtcHour,
  getBudget,
  checkVendorConstraints,
  checkVendorPricingCoverage,
  estimateRequestReserveCny,
  checkVendorCnyReservation,
  reserveVendorCny,
  releaseVendorCny,
  persistVendorSpend,
  extractRequestedModel,
  dispatchRequest,
  maxRequestBytes = 32 * 1024 * 1024,
  logger = console,
}) {
  let sequence = 0;

  return async function handleGatewayRequest(clientReq, clientRes) {
    const id = String(++sequence).padStart(4, '0');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const url = clientReq.url || '/';
    const parsedUrl = new URL(url, `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname;

    try {
      if (await controlPlane.handleGlobal(clientReq, clientRes, { pathname, parsedUrl })) return;

      const match = routeForPath(pathname);
      if (!match) {
        clientRes.writeHead(404, { 'content-type': 'text/plain' });
        const prefixes = Object.values(getVendors())
          .flatMap((vendor) => vendor.routes.map((route) => route.prefix));
        clientRes.end(
          `proxy: path must start with one of ${prefixes.join(', ')} ` +
          '(or /__status, /models)\n',
        );
        return;
      }
      const { vendor, route } = match;

      if (controlPlane.handleRouteDiscovery(clientReq, clientRes, {
        pathname,
        parsedUrl,
        url,
        vendor,
        route,
      })) return;

      const routeDecision = evaluateRouteRequest(route, clientReq.method, pathname);
      if (!routeDecision.allowed) {
        const headers = routeDecision.allow ? { allow: routeDecision.allow } : {};
        rejectByPath(
          clientRes,
          url,
          routeDecision.status,
          routeDecision.message,
          route,
          headers,
        );
        return;
      }

      const generationReady = await runtimeGeneration.waitForActivation(10_000);
      if (!generationReady) {
        rejectByPath(
          clientRes,
          url,
          503,
          'tomato-tap: configuration generation switch timed out',
          route,
        );
        return;
      }
      runtimeGeneration.trackResponse(clientRes);

      const format = route.format || 'openai';
      const pathPrefix = format === 'anthropic' ? '/anthropic' : '/v1';
      if (!inWindow()) {
        logger.log(
          `[${id}] BLOCK off-peak  (UTC hour ${new Date().getUTCHours()})  ` +
          `${clientReq.method} ${url}`,
        );
        rejectByPath(
          clientRes,
          url,
          503,
          `tomato-tap: outside off-peak window (UTC ${windowStartUtcHour}:00-${windowEndUtcHour}:00)`,
          route,
        );
        return;
      }

      const budget = getBudget();
      if (budget.used >= budget.total) {
        logger.log(
          `[${id}] BLOCK budget exhausted  (${budget.used}/${budget.total})  ` +
          `${clientReq.method} ${url}`,
        );
        rejectByPath(
          clientRes,
          url,
          503,
          `tomato-tap: credit budget exhausted (${budget.used}/${budget.total})`,
          route,
        );
        return;
      }

      const vendorConfig = getVendors()[vendor];
      const blockReason = checkVendorConstraints(vendor, vendorConfig);
      if (blockReason) {
        logger.log(
          `[${id}] BLOCK vendor-constraint vendor=${vendor} reason=${blockReason}  ` +
          `${clientReq.method} ${url}`,
        );
        rejectByPath(clientRes, url, 503, `tomato-tap: ${blockReason}`, route);
        return;
      }

      let requestBuffer;
      try {
        requestBuffer = await readRequestBody(clientReq, { maxBytes: maxRequestBytes });
      } catch (error) {
        const requestError = error instanceof RequestBodyError
          ? error
          : new RequestBodyError(`tomato-tap: client request error: ${error.message}`);
        logger.warn?.(
          `[${id}] BLOCK request-body code=${requestError.code} ` +
          `limit=${maxRequestBytes} ${clientReq.method} ${url}`,
        );
        rejectByPath(clientRes, url, requestError.status, requestError.message, route);
        return;
      }

      const requestedModel = extractRequestedModel(requestBuffer);
      const pricingBlockReason = checkVendorPricingCoverage(
        vendor,
        vendorConfig,
        requestedModel,
      );
      if (pricingBlockReason) {
        logger.log(
          `[${id}] BLOCK vendor-pricing vendor=${vendor} reason=${pricingBlockReason}  ` +
          `${clientReq.method} ${url}`,
        );
        rejectByPath(clientRes, url, 503, `tomato-tap: ${pricingBlockReason}`, route);
        return;
      }
      const reserveCny = estimateRequestReserveCny(
        vendorConfig,
        requestedModel,
        requestBuffer,
      );
      const reserveBlockReason = checkVendorCnyReservation(
        vendor,
        vendorConfig,
        reserveCny,
      );
      if (reserveBlockReason) {
        logger.log(
          `[${id}] BLOCK vendor-reserve vendor=${vendor} reason=${reserveBlockReason}  ` +
          `${clientReq.method} ${url}`,
        );
        rejectByPath(clientRes, url, 503, `tomato-tap: ${reserveBlockReason}`, route);
        return;
      }

      reserveVendorCny(vendor, reserveCny);
      try {
        await dispatchRequest(
          clientReq,
          clientRes,
          id,
          ts,
          url,
          pathPrefix,
          format,
          requestBuffer,
          vendor,
          route,
        );
      } catch (error) {
        logger.error(`[${id}] dispatch internal error: ${error.message}\n${error.stack}`);
        try {
          if (!clientRes.headersSent) {
            rejectByPath(clientRes, url, 500, 'tomato-tap: internal dispatch error', route);
          } else {
            clientRes.end();
          }
        } catch { /* already closed */ }
      } finally {
        releaseVendorCny(vendor, reserveCny);
        if (reserveCny > 0) persistVendorSpend();
      }
    } catch (error) {
      logger.error(`[${id}] request handler error: ${error.message}\n${error.stack}`);
      try {
        if (!clientRes.headersSent) clientRes.writeHead(500, { 'content-type': 'text/plain' });
        clientRes.end('tomato-tap: internal request handler error\n');
      } catch { /* already closed */ }
    }
  };
}
