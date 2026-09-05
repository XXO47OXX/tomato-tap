import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createProxyAgentPool } from '../../egress/proxy-agent-pool.mjs';
import { discoverRelayKeys, loadRelayRegistry } from '../relay-loader.mjs';
import { createQuotaControlClient } from './quota-control.mjs';
import { detectQuotaSignal } from './quota_infer.mjs';
import { validateOpenAIResponse } from '../../routing/response-validator.mjs';
import { adaptLogicalRequest } from '../../routing/request-adapter.mjs';
import { loadModelPolicy, realModelPolicy } from '../../routing/model-policy.mjs';
import { parseDotenv } from '../../config/runtime-config.mjs';
import { resolveStateLayout } from '../../config/state-layout.mjs';
import { applyLegacyEnvAliases } from '../../config/env-compat.mjs';
import { normalizeConfigBackend } from '../../config/config-backend.mjs';

process.umask(0o077);

export const PROBE_TICK_MS = 15_000;

const PROBE_PROXY_AGENTS = createProxyAgentPool({
  agentOptions: {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 8,
    maxFreeSockets: 4,
  },
});

export function createQuotaProber({
  controlClient,
  deployments,
  maxConcurrency = 2,
  timeoutMs = 30_000,
  reportRetryMs = 1_000,
  logger = (line) => console.log(line),
}) {
  let deploymentMap = deployments;
  const active = new Set();
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const capacity = Math.max(0, maxConcurrency - active.size);
      if (capacity === 0) return;
      const response = await controlClient.request({
        id: `claim-${Date.now()}`,
        method: 'claim_due',
        now: Date.now(),
        limit: capacity,
      });
      if (!response?.ok || !Array.isArray(response.claims)) return;
      await Promise.all(response.claims.map((claim) => runClaim(claim)));
    } finally {
      ticking = false;
    }
  }

  async function runClaim(claim) {
    const deploymentId = String(claim?.deploymentId || '');
    if (!deploymentId || active.has(deploymentId)) return;
    active.add(deploymentId);
    const deployment = deploymentMap.get(deploymentId);
    let result = {
      status: 0,
      headers: {},
      body: Buffer.alloc(0),
      networkError: null,
    };
    let validation = { valid: false, failureClass: 'deployment_missing' };
    let quotaSignal = null;
    try {
      if (!deployment) throw new Error('deployment metadata missing');
      if (deployment.expiresAtMs > 0 && Date.now() >= deployment.expiresAtMs) {
        result = {
          status: 410,
          headers: {},
          body: Buffer.from('{"error":{"message":"relay credential expired"}}'),
          networkError: null,
        };
        validation = { valid: false, failureClass: 'expired' };
      } else {
        let requestBody = {
          model: claim.probeModel,
          messages: [{
            role: 'user',
            content: 'Return exactly one compact JSON object: {"ok":true}',
          }],
          stream: false,
          temperature: 0,
          max_tokens: claim.probeMaxTokens,
        };
        if (deployment.quotaSignalProfile === 'kimi-coding'
            && /^(?:kimi-)?k3(?:-|$)/i.test(claim.probeModel)) {
          requestBody.reasoning_effort = 'low';
        }
        if ((deployment.thinkingAdapter && deployment.thinkingAdapter !== 'none')
            || deployment.requestPolicy) {
          requestBody = JSON.parse(adaptLogicalRequest(
            Buffer.from(JSON.stringify(requestBody)),
            { 'content-type': 'application/json' },
            {
              upstreamModel: claim.probeModel,
              thinkingAdapter: deployment.thinkingAdapter,
              maxTokensMultiplier: 1,
              requestPolicy: deployment.requestPolicy,
            },
          ).toString('utf8'));
        }
        result = await sendProbe(deployment, requestBody, timeoutMs);
        validation = probeUsesAnthropic(deployment)
          ? validateAnthropicProbe(result)
          : validateOpenAIResponse(result, { requestBody });
        quotaSignal = detectQuotaSignal(result, deployment);
      }
    } catch (error) {
      result = {
        status: 0,
        headers: {},
        body: Buffer.alloc(0),
        networkError: error,
      };
      validation = { valid: false, failureClass: 'network' };
    }

    try {
      const report = {
        id: `report-${deploymentId}-${Date.now()}`,
        method: 'report_probe',
        deploymentId,
        claimToken: String(claim.claimToken || ''),
        valid: validation.valid === true,
        status: Number(result.status) || 0,
        failureClass: validation.failureClass || '',
        quotaSignal,
        observedAt: Date.now(),
      };
      let response;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await controlClient.request(report);
          if (response?.ok === true) break;
          if (attempt === 3) throw new Error(response?.error || 'probe report rejected');
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, reportRetryMs));
        }
      }
      logger(
        `[quota-prober] deployment=${deploymentId} status=${Number(result.status) || 0}`
        + ` valid=${validation.valid === true} accepted=${response?.accepted === true}`
        + ` failure=${validation.failureClass || 'none'}`,
      );
    } finally {
      active.delete(deploymentId);
    }
  }

  async function drain(timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    while ((ticking || active.size > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function replaceDeployments(next) {
    if (!(next instanceof Map)) throw new Error('quota-prober deployments must be a Map');
    deploymentMap = next;
  }

  return { tick, drain, replaceDeployments };
}

function probeUsesAnthropic(deployment) {
  const formats = deployment?.apiFormats;
  const hasAnthropic = formats && typeof formats.has === 'function'
    ? formats.has('anthropic')
    : Array.isArray(formats) && formats.includes('anthropic');
  const prefix = String(deployment?.pathPrefix || '').replace(/\/$/, '');
  return hasAnthropic === true && !prefix.endsWith('/v1');
}

function validateAnthropicProbe(result) {
  if (result.networkError) return { valid: false, failureClass: 'network' };
  if (result.status !== 200) return { valid: false, failureClass: 'http_status' };
  try {
    const body = JSON.parse(result.body.toString('utf8'));
    return Array.isArray(body?.content) && body.content.length > 0
      ? { valid: true, failureClass: '' }
      : { valid: false, failureClass: 'wrapped_error' };
  } catch {
    return { valid: false, failureClass: 'invalid_json' };
  }
}

export function buildProbeHeaders(deployment, { anthropic, bodyLength }) {
  const headers = { ...(deployment?.headers || {}) };
  deleteHeader(headers, 'authorization');
  deleteHeader(headers, 'x-api-key');
  const authType = String(
    deployment?.authType || (anthropic ? 'x-api-key' : 'bearer'),
  ).trim().toLowerCase();
  if (authType === 'x-api-key') setHeader(headers, 'x-api-key', deployment.value);
  else if (authType === 'bearer') setHeader(headers, 'authorization', `Bearer ${deployment.value}`);
  else throw new Error(`unsupported probe auth policy: ${authType}`);
  if (anthropic && !hasHeader(headers, 'anthropic-version')) {
    setHeader(headers, 'anthropic-version', '2023-06-01');
  }
  setHeader(headers, 'content-type', 'application/json');
  setHeader(headers, 'content-length', String(bodyLength));
  if (!hasHeader(headers, 'accept')) setHeader(headers, 'accept', 'application/json');
  if (!hasHeader(headers, 'user-agent')) {
    setHeader(headers, 'user-agent', 'opencode/tomato-tap-quota-prober');
  }
  return headers;
}

function sendProbe(deployment, requestBody, timeoutMs) {
  const anthropic = probeUsesAnthropic(deployment);
  const payload = anthropic ? {
    model: requestBody.model,
    messages: requestBody.messages,
    max_tokens: requestBody.max_tokens,
    ...(requestBody.reasoning_effort ? { reasoning_effort: requestBody.reasoning_effort } : {}),
  } : requestBody;
  const body = Buffer.from(JSON.stringify(payload));
  const transport = deployment.proto === 'http' ? http : https;
  const targetProtocol = deployment.proto === 'http' ? 'http:' : 'https:';
  const prefix = String(deployment.pathPrefix || '').replace(/\/$/, '');
  const path = anthropic ? `${prefix}/v1/messages` : `${prefix}/chat/completions`;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = transport.request({
      host: deployment.host,
      port: deployment.port,
      path,
      method: 'POST',
      agent: deployment.proxyUrl
        ? PROBE_PROXY_AGENTS.get(deployment.proxyUrl, targetProtocol)
        : false,
      headers: buildProbeHeaders(deployment, { anthropic, bodyLength: body.length }),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
        else req.destroy(new Error('probe response too large'));
      });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        statusMessage: res.statusMessage || '',
        headers: res.headers,
        body: Buffer.concat(chunks),
        networkError: null,
        elapsedMs: Date.now() - startedAt,
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('probe timeout')));
    req.on('error', (error) => resolve({
      status: 0,
      statusMessage: '',
      headers: {},
      body: Buffer.alloc(0),
      networkError: error,
      elapsedMs: Date.now() - startedAt,
    }));
    req.end(body);
  });
}

function hasHeader(headers, expected) {
  return Object.keys(headers).some((name) => name.toLowerCase() === expected);
}

function deleteHeader(headers, expected) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === expected) delete headers[name];
  }
}

function setHeader(headers, name, value) {
  deleteHeader(headers, name.toLowerCase());
  headers[name] = value;
}

function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name && process.env[name] === undefined) process.env[name] = value;
  }
}

export async function runQuotaProber() {
  applyLegacyEnvAliases(process.env, { warn: true });
  const processEnvOverrides = { ...process.env };
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const repoEnvPath = join(projectRoot, '.env');
  const envPath = process.env.TOMATO_TAP_ENV_FILE || repoEnvPath;
  loadDotenv(envPath);
  applyLegacyEnvAliases(process.env, { warn: true });
  const relaysPath = process.env.TOMATO_TAP_RELAYS_PATH || join(projectRoot, 'config', 'relays.json');
  const modelsPath = process.env.TOMATO_TAP_MODELS_PATH || join(projectRoot, 'config', 'models.json');
  const stateLayout = resolveStateLayout(projectRoot, process.env);
  const requestedBackend = normalizeConfigBackend(process.env.TOMATO_TAP_CONFIG_BACKEND);
  let sqliteStore = null;
  if (requestedBackend !== 'files') {
    try {
      const { createSqliteConfigStore } = await import('../../config/sqlite-config-store.mjs');
      const candidate = createSqliteConfigStore({
        path: process.env.TOMATO_TAP_CONFIG_DB_PATH
          || join(stateLayout.runtimeDir, 'tomato-config.db'),
      });
      if (candidate.snapshot()) sqliteStore = candidate;
      else candidate.close();
    } catch (error) {
      const unsupported = error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
        || /node:sqlite|No such built-in module/i.test(String(error?.message || ''));
      if (requestedBackend !== 'auto' || !unsupported) throw error;
    }
  }
  if (requestedBackend === 'sqlite' && !sqliteStore) {
    throw new Error('TOMATO_TAP_CONFIG_BACKEND=sqlite requires an active SQLite configuration registry');
  }
  const initialCatalog = loadProbeCatalog({
    envPath,
    relaysPath,
    modelsPath,
    processEnvOverrides,
    sqliteSnapshotLoader: sqliteStore ? () => sqliteStore.snapshot() : null,
  });
  const socketPath = process.env.TOMATO_TAP_QUOTA_SOCKET_PATH
    || join(stateLayout.runtimeDir, 'quota-control.sock');
  const client = createQuotaControlClient({
    socketPath,
    timeoutMs: Number(process.env.TOMATO_TAP_QUOTA_CONTROL_TIMEOUT_MS || 5_000),
  });
  const prober = createQuotaProber({
    controlClient: client,
    deployments: initialCatalog.deployments,
    maxConcurrency: Number(process.env.TOMATO_TAP_QUOTA_PROBE_CONCURRENCY || 2),
    timeoutMs: Number(process.env.TOMATO_TAP_QUOTA_PROBE_TIMEOUT_MS || 30_000),
  });
  let catalogRevision = initialCatalog.revision;
  let stopping = false;
  const runTick = () => {
    if (stopping) return;
    try {
      const catalog = loadProbeCatalog({
        envPath,
        relaysPath,
        modelsPath,
        processEnvOverrides,
        sqliteSnapshotLoader: sqliteStore ? () => sqliteStore.snapshot() : null,
      });
      if (catalog.revision !== catalogRevision) {
        prober.replaceDeployments(catalog.deployments);
        catalogRevision = catalog.revision;
        console.log(`[quota-prober] activated config revision=${catalogRevision} deployments=${catalog.deployments.size}`);
      }
    } catch (error) {
      console.error(`[quota-prober] config reload rejected: ${String(error?.message || error).slice(0, 512)}`);
    }
    prober.tick().catch((error) => {
      console.error(`[quota-prober] tick failed: ${error.message}`);
    });
  };
  runTick();
  const timer = setInterval(runTick, PROBE_TICK_MS);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await prober.drain();
    sqliteStore?.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

function loadProbeCatalog({
  envPath,
  relaysPath,
  modelsPath,
  processEnvOverrides = {},
  sqliteSnapshotLoader = null,
}) {
  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const sqliteSnapshot = sqliteSnapshotLoader?.() || null;
  const relayDocument = sqliteSnapshot?.relays || null;
  const modelDocument = sqliteSnapshot?.models || null;
  const relayText = relayDocument
    ? JSON.stringify(relayDocument)
    : readFileSync(relaysPath, 'utf8');
  const modelText = modelDocument
    ? JSON.stringify(modelDocument)
    : readFileSync(modelsPath, 'utf8');
  const env = {
    ...(sqliteSnapshot?.env || parseDotenv(envText)),
    ...processEnvOverrides,
  };
  const registry = loadRelayRegistry({ path: relaysPath, document: relayDocument });
  const modelPolicy = loadModelPolicy({ path: modelsPath, document: modelDocument });
  const deployments = new Map();
  const discovered = discoverRelayKeys(
    'relay',
    /^(?:tomato_tap|mimotap)_relay_(.+?)_key$/i,
    env,
    registry,
  );
  for (const deployment of discovered) {
    if (!deployment.quotaPolicy) continue;
    const probePolicy = realModelPolicy(modelPolicy, deployment.quotaPolicy.probeModel);
    deployments.set(deployment.deploymentId, {
      ...deployment,
      thinkingAdapter: probePolicy?.thinkingAdapter || 'none',
    });
  }
  const revision = createHash('sha256')
    .update(sqliteSnapshot ? JSON.stringify(sqliteSnapshot.env) : envText).update('\0')
    .update(relayText).update('\0')
    .update(modelText)
    .update('\0').update(String(sqliteSnapshot?.revision || 0))
    .digest('hex').slice(0, 16);
  return { revision, deployments };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  await runQuotaProber();
}
