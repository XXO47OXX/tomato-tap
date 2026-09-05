const MODEL_ID = 'cursor-agent';

// The ACP credential belongs to the child process, not to the HTTP facade.
// This synthetic deployment only lets the ordinary dispatcher reach the
// loopback bridge without requiring operators to create a fake registry key.
export function appendCursorAcpDeployment(deployments, {
  enabled = false,
  host = '127.0.0.1',
  port = 8891,
  maxConcurrent = 1,
  apiKey = '',
} = {}) {
  let output = Array.isArray(deployments)
    ? deployments.map((deployment) => ({ ...deployment }))
    : [];
  if (!enabled || !String(apiKey).trim()) {
    return output;
  }
  const existingBridge = output.some((deployment) => (
    deployment.vendor === 'cursor_acp'
    && String(deployment.host || '') === String(host)
    && Number(deployment.port) === Number(port)
    && String(deployment.pathPrefix || '').replace(/\/$/, '') === '/v1'
    && (deployment.modelSet?.has?.(MODEL_ID)
      || deployment.nativeModels?.includes?.(MODEL_ID))
  ));
  if (existingBridge) return output;

  // Older builds discovered the child credential as if it were an HTTP API
  // key. That entry has neither a model set nor the bridge port/path and must
  // not compete with the synthetic local transport.
  output = output.filter((deployment) => !(
    deployment.vendor === 'cursor_acp'
    && ['tomato_tap_cursor_acp_credential', 'mimotap_cursor_acp_credential'].includes(deployment.name)
    && !deployment.modelSet
  ));
  output.push({
    endpointId: 'cursor_acp:local-bridge',
    providerId: 'cursor-acp-local',
    deploymentId: 'cursor-acp-local',
    credentialId: 'cursor-acp-local',
    name: 'cursor_acp_local_bridge',
    value: 'local-bridge',
    vendor: 'cursor_acp',
    host,
    pathPrefix: '/v1',
    proto: 'http',
    port,
    modelSet: new Set([MODEL_ID]),
    upstreamModelSet: new Set([MODEL_ID]),
    canonicalModelSet: new Set([MODEL_ID]),
    apiFormats: new Set(['openai']),
    nativeModels: [MODEL_ID],
    useProxy: false,
    proxyPolicy: { mode: 'direct', nodeId: null },
    baseWeight: 1,
    capInitial: maxConcurrent,
    capMin: maxConcurrent,
    capMax: maxConcurrent,
    expiresAtMs: 0,
  });
  return output;
}

