export function annotateResponse(result, meta) {
  const headers = { ...(result.headers || {}) };
  delete headers['content-length'];
  delete headers['Content-Length'];

  const metadata = responseMetadata(meta);
  setMetadataHeaders(headers, 'x-tomato-tap-', metadata);
  // Pre-release clients may still consume the legacy x-mimo-* headers.
  setMetadataHeaders(headers, 'x-mimo-', metadata);

  let body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body || '');
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = JSON.parse(body.toString('utf8'));
    payload.model = meta.resolvedModel;
    payload.tomato_tap = metadata;
    payload.mimo_tap = metadata;
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  }
  headers['content-length'] = String(body.length);
  return { ...result, headers, body };
}

function responseMetadata(meta) {
  return {
    requested_model: meta.requestedModel,
    task: meta.taskName || '',
    selected_model: meta.selectedModel,
    resolved_model: meta.resolvedModel,
    upstream_reported_model: meta.upstreamReportedModel || '',
    deployment: meta.deploymentId,
    vendor: meta.vendor,
    attempts: meta.attempts,
    model_switched: Boolean(meta.modelSwitched),
  };
}

function setMetadataHeaders(headers, prefix, metadata) {
  headers[`${prefix}requested-model`] = headerValue(metadata.requested_model);
  headers[`${prefix}task`] = headerValue(metadata.task);
  headers[`${prefix}selected-model`] = headerValue(metadata.selected_model);
  headers[`${prefix}resolved-model`] = headerValue(metadata.resolved_model);
  headers[`${prefix}upstream-reported-model`] = headerValue(metadata.upstream_reported_model);
  headers[`${prefix}deployment`] = headerValue(metadata.deployment);
  headers[`${prefix}vendor`] = headerValue(metadata.vendor);
  headers[`${prefix}attempts`] = String(metadata.attempts);
  headers[`${prefix}model-switched`] = metadata.model_switched ? '1' : '0';
}

function headerValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '');
}
