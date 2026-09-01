// Admin-facing configuration orchestration. Validation and filesystem
// transactions live in sibling modules so this layer only coordinates the
// relay, model-policy, and credential documents.

import { parseDotenv } from '../config/runtime-config.mjs';
import {
  boundedInteger,
  DEFAULT_REAL_MODEL,
  normalizeBasePath,
  normalizeCapabilities,
  normalizeEgressInput,
  normalizeModelName,
  normalizeProviderDiscoveryInput,
  normalizeProviderInput,
  normalizeRealModelInput,
  normalizeSettings,
  normalizeSlug,
  OPERATOR_MANAGED_SETTINGS,
  uniqueNames,
} from './config-input.mjs';
import {
  atomicWriteJson,
  readJson,
  readOptional,
  redactPath,
  updateEnvFile,
  validateCandidateDocuments,
} from './private-config-files.mjs';
import { normalizeRequestPolicy, requestPolicyJSON } from '../routing/request-policy.mjs';

export { ensureOperatorConfigFiles } from './private-config-files.mjs';
export { OPERATOR_MANAGED_SETTINGS } from './config-input.mjs';

export function createOperatorConfigStore({
  envPath,
  relaysPath,
  modelsPath,
  processEnvOverrides = {},
  repository = null,
} = {}) {
  for (const [label, path] of Object.entries({ envPath, relaysPath, modelsPath })) {
    if (!path) throw new Error(`operator config requires ${label}`);
  }
  const config = repository || createFileRepository({ envPath, relaysPath, modelsPath });

  function snapshot() {
    const relays = config.readRelays();
    const models = config.readModels();
    const fileEnv = config.readEnv();
    const effectiveEnv = { ...fileEnv, ...processEnvOverrides };
    const localSource = config.mode === 'sqlite' ? 'sqlite' : 'file';
    const providers = Object.entries(relays.relays || {})
      .map(([id, relay]) => providerSummary(
        id, relay, fileEnv, processEnvOverrides, localSource,
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
    const realModels = Object.entries(models.realModels || {}).map(([name, policy]) => ({
      name,
      ...policy,
    }));
    const logicalModels = Object.entries(models.logicalModels || {}).map(([name, policy]) => ({
      name,
      ...policy,
    }));
    const enabledProviders = providers.filter((provider) => (
      provider.enabled && provider.credential.configured && provider.models.length > 0
    ));
    return {
      configured: enabledProviders.length > 0,
      storage: config.mode,
      paths: {
        env: redactPath(config.paths.env),
        relays: redactPath(config.paths.relays),
        models: redactPath(config.paths.models),
      },
      providers,
      realModels,
      logicalModels,
      egress: egressSummary(fileEnv, processEnvOverrides, localSource),
      settings: Object.fromEntries(OPERATOR_MANAGED_SETTINGS.map((name) => [
        name,
        String(effectiveEnv[name] ?? ''),
      ])),
    };
  }

  function upsertProvider(input) {
    const provider = normalizeProviderInput(input);
    const relays = config.readRelays();
    const models = config.readModels();
    const fileEnv = config.readEnv();
    const credentialEnvName = credentialName(provider.id);
    const legacyCredentialEnvName = legacyCredentialName(provider.id);
    const credentialFromProcess = Object.hasOwn(processEnvOverrides, credentialEnvName)
      || Object.hasOwn(processEnvOverrides, legacyCredentialEnvName);
    if ((provider.apiKey || provider.clearCredential) && credentialFromProcess) {
      throw new Error(`${credentialEnvName} is supplied by the process environment and is not writable`);
    }
    const fixedProxyName = proxyCredentialName(provider.id);
    const fixedProxyFromProcess = processEnvOverrides[fixedProxyName];
    const existingFixedProxy = fixedProxyFromProcess ?? fileEnv[fixedProxyName] ?? '';
    const fixedProxyMode = provider.proxy?.mode === 'fixed-http';
    if (fixedProxyMode && !provider.fixedProxyUrl && !existingFixedProxy) {
      throw new Error('fixed HTTP proxy mode requires a proxy URL');
    }
    if (provider.fixedProxyUrl && fixedProxyFromProcess) {
      throw new Error(`${fixedProxyName} is not writable`);
    }
    if (!fixedProxyMode && fixedProxyFromProcess) {
      throw new Error(`${fixedProxyName} is supplied by the process environment and keeps fixed HTTP proxy mode active`);
    }
    if (isStarterRelayDocument(relays)) relays.relays = {};
    if (isStarterModelDocument(models)) {
      models.realModels = {};
      models.taskSubtypes = {};
      models.logicalModels = {};
    }

    relays.schemaVersion = 1;
    relays.relays ||= {};
    const existing = relays.relays[provider.id] || null;
    const template = provider.templateProviderId
      ? relays.relays[provider.templateProviderId]
      : null;
    if (provider.templateProviderId && !template) {
      throw new Error(`unknown provider template ${provider.templateProviderId}`);
    }
    const channelPolicy = existing || template || {};
    const modelMapping = preserveModelMapping(channelPolicy, provider.models);
    const headers = withoutHeader(channelPolicy.headers, 'user-agent');
    if (provider.userAgent) headers['User-Agent'] = provider.userAgent;
    const relay = {
      ...channelPolicy,
      provider: provider.label,
      disabled: !provider.enabled,
      host: provider.url.hostname,
      proto: provider.url.protocol.slice(0, -1),
      port: provider.port,
      path: normalizeBasePath(provider.url.pathname),
      models: provider.models,
      canonicalModels: modelMapping.canonicalModels,
      apiFormats: [provider.apiFormat],
      auth: provider.auth,
      cap: provider.cap,
      proxy: fixedProxyMode ? false : provider.proxy,
    };
    if (Object.keys(modelMapping.aliases).length > 0) relay.aliases = modelMapping.aliases;
    else delete relay.aliases;
    if (Object.keys(headers).length > 0) relay.headers = headers;
    else delete relay.headers;
    if (provider.requestsPerMinute) {
      relay.rateLimit = {
        requestsPerMinute: provider.requestsPerMinute,
        mode: provider.rateLimitMode,
      };
    } else {
      delete relay.rateLimit;
    }
    relays.relays[provider.id] = relay;

    models.schemaVersion = 1;
    models.realModels ||= {};
    models.taskSubtypes ||= {};
    models.logicalModels ||= {};
    for (const name of modelMapping.canonicalModels) {
      models.realModels[name] ||= {
        ...DEFAULT_REAL_MODEL,
        qualityTier: provider.qualityTier,
        capabilities: provider.capabilities,
        thinkingAdapter: provider.thinkingAdapter,
        maxInflight: provider.modelMaxInflight,
      };
    }
    if (provider.logicalModel) {
      const previous = models.logicalModels[provider.logicalModel];
      const candidates = uniqueNames([
        ...(previous?.candidates || []),
        ...modelMapping.canonicalModels,
      ]);
      models.logicalModels[provider.logicalModel] = {
        ...previous,
        requiredCapabilities: provider.logicalCapabilities,
        candidates,
        candidateStrategy: previous?.candidateStrategy || 'fair',
        maxInflight: previous?.maxInflight || provider.logicalMaxInflight,
        maxAttempts: previous?.maxAttempts || Math.min(4, Math.max(1, candidates.length)),
        deadlineMs: previous?.deadlineMs || 300_000,
        logicalAdmissionWaitMs: previous?.logicalAdmissionWaitMs || 30_000,
      };
    }
    ensureAtLeastOneLogicalModel(models, modelMapping.canonicalModels);

    validateCandidateDocuments(relaysPath, relays, modelsPath, models);
    const envChanges = {};
    if (provider.apiKey) {
      envChanges[credentialEnvName] = provider.apiKey;
      envChanges[legacyCredentialEnvName] = null;
    } else if (provider.clearCredential === true) {
      envChanges[credentialEnvName] = null;
      envChanges[legacyCredentialEnvName] = null;
    }
    if (provider.fixedProxyUrl) {
      envChanges[fixedProxyName] = provider.fixedProxyUrl;
    } else if (!fixedProxyMode && fileEnv[fixedProxyName]) {
      envChanges[fixedProxyName] = null;
    }
    config.commit({ relays, models, envChanges });
    return snapshot();
  }

  function setProviderEnabled(id, enabled) {
    id = normalizeSlug(id);
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    const relays = config.readRelays();
    if (!relays.relays?.[id]) throw new Error(`unknown provider ${id}`);
    relays.relays[id].disabled = !enabled;
    validateCandidateDocuments(relaysPath, relays, modelsPath, config.readModels());
    config.writeRelays(relays);
    return snapshot();
  }

  function removeProvider(id, { clearCredential = true } = {}) {
    id = normalizeSlug(id);
    const processSecretNames = [
      credentialName(id),
      legacyCredentialName(id),
      proxyCredentialName(id),
    ];
    if (processSecretNames.some((name) => Object.hasOwn(processEnvOverrides, name))) {
      throw new Error(`provider ${id} has process-managed secrets; remove them from the process environment first`);
    }
    const relays = config.readRelays();
    if (!relays.relays?.[id]) throw new Error(`unknown provider ${id}`);
    delete relays.relays[id];
    validateCandidateDocuments(relaysPath, relays, modelsPath, config.readModels());
    const envChanges = {};
    if (clearCredential) {
      envChanges[credentialName(id)] = null;
      envChanges[legacyCredentialName(id)] = null;
      envChanges[proxyCredentialName(id)] = null;
    }
    config.commit({ relays, envChanges });
    return snapshot();
  }

  function upsertLogicalModel(input) {
    const models = config.readModels();
    const name = normalizeModelName(input?.name, 'logical model name');
    const candidates = uniqueNames(input?.candidates || []);
    if (candidates.length === 0) throw new Error('logical model requires at least one candidate');
    const realNames = new Set(Object.keys(models.realModels || {}).map((item) => item.toLowerCase()));
    for (const candidate of candidates) {
      if (!realNames.has(candidate.toLowerCase())) {
        throw new Error(`logical model candidate is not configured: ${candidate}`);
      }
    }
    const requiredCapabilities = normalizeCapabilities(
      input?.requiredCapabilities || ['instruction_following'],
    );
    models.logicalModels ||= {};
    const existingName = Object.keys(models.logicalModels).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    const previous = existingName ? models.logicalModels[existingName] : {};
    const candidateStrategy = String(input?.candidateStrategy || 'fair').trim().toLowerCase();
    if (!['fair', 'ordered', 'adaptive'].includes(candidateStrategy)) {
      throw new Error('candidateStrategy must be fair, ordered, or adaptive');
    }
    const next = {
      ...previous,
      requiredCapabilities,
      candidates,
      candidateStrategy,
      maxInflight: boundedInteger(input?.maxInflight, 'maxInflight', 1, 10_000, 8),
      maxAttempts: boundedInteger(input?.maxAttempts, 'maxAttempts', 1, 100, Math.min(4, candidates.length)),
      deadlineMs: boundedInteger(input?.deadlineMs, 'deadlineMs', 1_000, 3_600_000, 300_000),
      logicalAdmissionWaitMs: boundedInteger(
        input?.logicalAdmissionWaitMs,
        'logicalAdmissionWaitMs',
        0,
        3_600_000,
        30_000,
      ),
    };
    if (Object.hasOwn(input || {}, 'qualityTier')) {
      const qualityTier = String(input.qualityTier || '').trim();
      if (qualityTier) next.qualityTier = normalizeModelName(qualityTier, 'quality tier');
      else delete next.qualityTier;
    }
    for (const field of [
      'sessionAffinity',
      'allowWeakFallback',
      'protected',
      'preferDifferentFromPrevious',
    ]) {
      if (Object.hasOwn(input || {}, field)) {
        if (typeof input[field] !== 'boolean') throw new Error(`${field} must be boolean`);
        next[field] = input[field];
      }
    }
    if (Object.hasOwn(input || {}, 'minReadySlots')) {
      const minReadySlots = boundedInteger(input.minReadySlots, 'minReadySlots', 0, 10_000, 0);
      if (minReadySlots > 0) next.minReadySlots = minReadySlots;
      else delete next.minReadySlots;
    }
    if (Object.hasOwn(input || {}, 'request')) {
      const request = requestPolicyJSON(normalizeRequestPolicy(input.request, {
        label: 'logical model request',
      }));
      if (request) next.request = request;
      else delete next.request;
    }
    if (existingName && existingName !== name) delete models.logicalModels[existingName];
    models.logicalModels[name] = next;
    validateCandidateDocuments(relaysPath, config.readRelays(), modelsPath, models);
    config.writeModels(models);
    return snapshot();
  }

  function upsertRealModel(input) {
    const model = normalizeRealModelInput(input);
    const models = config.readModels();
    const actual = Object.keys(models.realModels || {}).find(
      (candidate) => candidate.toLowerCase() === model.name.toLowerCase(),
    );
    if (!actual) throw new Error(`unknown real model ${model.name}; add it to a provider first`);
    models.realModels[actual] = {
      ...models.realModels[actual],
      qualityTier: model.qualityTier,
      capabilities: model.capabilities,
      thinkingAdapter: model.thinkingAdapter,
      maxTokensMultiplier: model.maxTokensMultiplier,
      maxInflight: model.maxInflight,
      initialLatencyMs: model.initialLatencyMs,
      firstByteTimeoutMs: model.firstByteTimeoutMs,
      totalTimeoutMs: model.totalTimeoutMs,
      standaloneOnly: model.standaloneOnly,
    };
    validateCandidateDocuments(relaysPath, config.readRelays(), modelsPath, models);
    config.writeModels(models);
    return snapshot();
  }

  function removeLogicalModel(name) {
    name = normalizeModelName(name, 'logical model name');
    const models = config.readModels();
    const actual = Object.keys(models.logicalModels || {})
      .find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (!actual) throw new Error(`unknown logical model ${name}`);
    if (Object.keys(models.logicalModels).length <= 1) {
      throw new Error('at least one logical model must remain configured');
    }
    delete models.logicalModels[actual];
    validateCandidateDocuments(relaysPath, config.readRelays(), modelsPath, models);
    config.writeModels(models);
    return snapshot();
  }

  function updateSettings(values) {
    config.updateEnv(normalizeSettings(values));
    return snapshot();
  }

  function updateEgress(values) {
    const changes = normalizeEgressInput(values);
    for (const name of Object.keys(changes)) {
      if (Object.hasOwn(processEnvOverrides, name)) {
        throw new Error(`${name} is supplied by the process environment and is not writable`);
      }
    }
    if (Object.keys(changes).length > 0) config.updateEnv(changes);
    return snapshot();
  }

  function providerDiscoveryTarget(input) {
    const fileEnv = config.readEnv();
    const id = input?.id ? normalizeSlug(input.id) : '';
    const relay = id ? config.readRelays().relays?.[id] : null;
    const envName = id ? credentialName(id) : '';
    const legacyName = id ? `mimotap_relay_${id}_key` : '';
    const fallback = relay ? {
      baseUrl: composeBaseUrl(relay),
      apiFormat: Array.isArray(relay.apiFormats) ? relay.apiFormats[0] : 'openai',
      auth: relay.auth || (relay.apiFormats?.[0] === 'anthropic' ? 'x-api-key' : 'bearer'),
      apiKey: processEnvOverrides[envName]
        ?? processEnvOverrides[legacyName]
        ?? fileEnv[envName]
        ?? fileEnv[legacyName]
        ?? '',
    } : {};
    return normalizeProviderDiscoveryInput(input, fallback);
  }

  return Object.freeze({
    snapshot,
    upsertProvider,
    setProviderEnabled,
    removeProvider,
    upsertLogicalModel,
    upsertRealModel,
    removeLogicalModel,
    updateSettings,
    updateEgress,
    providerDiscoveryTarget,
  });
}

function createFileRepository({ envPath, relaysPath, modelsPath }) {
  return Object.freeze({
    mode: 'files',
    paths: Object.freeze({ env: envPath, relays: relaysPath, models: modelsPath }),
    readEnv: () => parseDotenv(readOptional(envPath)),
    readRelays: () => readJson(relaysPath),
    readModels: () => readJson(modelsPath),
    writeRelays: (value) => atomicWriteJson(relaysPath, value),
    writeModels: (value) => atomicWriteJson(modelsPath, value),
    updateEnv: (changes) => updateEnvFile(envPath, changes),
    commit({ relays, models, envChanges = {} } = {}) {
      if (relays) atomicWriteJson(relaysPath, relays);
      if (models) atomicWriteJson(modelsPath, models);
      if (Object.keys(envChanges).length > 0) updateEnvFile(envPath, envChanges);
    },
  });
}

function egressSummary(fileEnv, processEnvOverrides, localSource = 'files') {
  const effective = { ...fileEnv, ...processEnvOverrides };
  const source = (names) => {
    if (names.some((name) => Object.hasOwn(processEnvOverrides, name))) return 'process';
    if (names.some((name) => Object.hasOwn(fileEnv, name))) return localSource;
    return 'none';
  };
  const subscriptionNames = [
    'TOMATO_TAP_PROXY_SUBSCRIPTION_URL',
    'TOMATO_TAP_PROXY_SUBSCRIPTION_URLS',
  ];
  const subscriptionCount = [
    effective.TOMATO_TAP_PROXY_SUBSCRIPTION_URL || '',
    effective.TOMATO_TAP_PROXY_SUBSCRIPTION_URLS || '',
  ].flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean).length;
  const state = (names, configured) => {
    const valueSource = source(names);
    return {
      configured,
      source: valueSource,
      writable: valueSource !== 'process',
    };
  };
  const explicitSharedProxy = state(
    ['TOMATO_TAP_SHARED_PROXY_URL'],
    Boolean(effective.TOMATO_TAP_SHARED_PROXY_URL),
  );
  const fallbackSharedProxy = effective.HTTPS_PROXY || effective.https_proxy || '';
  return {
    subscriptions: {
      ...state(subscriptionNames, subscriptionCount > 0),
      count: subscriptionCount,
    },
    staticNodes: state(
      ['TOMATO_TAP_PROXY_STATIC_NODES'],
      Boolean(effective.TOMATO_TAP_PROXY_STATIC_NODES),
    ),
    sharedProxy: explicitSharedProxy.configured
      ? { ...explicitSharedProxy, fallback: false }
      : {
          configured: Boolean(fallbackSharedProxy),
          source: fallbackSharedProxy ? 'network-env' : 'none',
          writable: true,
          fallback: Boolean(fallbackSharedProxy),
        },
    singBox: {
      binary: String(effective.TOMATO_TAP_SING_BOX_BIN || 'sing-box'),
      portStart: Number(effective.TOMATO_TAP_PROXY_PORT_START || 11001),
      portEnd: Number(effective.TOMATO_TAP_PROXY_PORT_END || 11999),
    },
  };
}

function providerSummary(id, relay, fileEnv, processEnvOverrides, localSource = 'files') {
  const envName = credentialName(id);
  const legacyName = `mimotap_relay_${id}_key`;
  const source = processEnvOverrides[envName] != null || processEnvOverrides[legacyName] != null
    ? 'process'
    : fileEnv[envName] != null || fileEnv[legacyName] != null
      ? localSource
      : 'none';
  const credential = source === 'process'
    ? processEnvOverrides[envName] ?? processEnvOverrides[legacyName]
    : fileEnv[envName] ?? fileEnv[legacyName];
  const fixedProxyName = proxyCredentialName(id);
  const fixedProxySource = processEnvOverrides[fixedProxyName] != null
    ? 'process'
    : fileEnv[fixedProxyName] != null ? localSource : 'none';
  const fixedProxyConfigured = fixedProxySource !== 'none';
  return {
    id,
    label: String(relay.provider || id),
    enabled: relay.disabled !== true,
    baseUrl: composeBaseUrl(relay),
    apiFormat: Array.isArray(relay.apiFormats) ? relay.apiFormats[0] || 'openai' : 'openai',
    auth: relay.auth || (relay.apiFormats?.[0] === 'anthropic' ? 'x-api-key' : 'bearer'),
    userAgent: headerValue(relay.headers, 'user-agent'),
    models: Array.isArray(relay.models) ? relay.models : [],
    canonicalModels: Array.isArray(relay.canonicalModels) ? relay.canonicalModels : [],
    aliases: relay.aliases && typeof relay.aliases === 'object' ? { ...relay.aliases } : {},
    cap: {
      min: relay.cap?.min || 1,
      initial: relay.cap?.initial || 1,
      max: relay.cap?.max || 4,
    },
    rateLimit: relay.rateLimit || null,
    proxy: fixedProxyConfigured ? { mode: 'fixed-http' } : relay.proxy ?? false,
    fixedProxy: {
      configured: fixedProxyConfigured,
      source: fixedProxySource,
      writable: fixedProxySource !== 'process',
    },
    credential: {
      configured: typeof credential === 'string' && credential.length > 0,
      source,
      writable: source !== 'process',
    },
  };
}

function ensureAtLeastOneLogicalModel(models, candidates) {
  if (Object.keys(models.logicalModels || {}).length > 0) return;
  models.logicalModels = {
    balanced: {
      requiredCapabilities: ['instruction_following'],
      candidates: [candidates[0]],
      candidateStrategy: 'fair',
      maxInflight: 8,
      maxAttempts: 2,
      deadlineMs: 300_000,
      logicalAdmissionWaitMs: 30_000,
    },
  };
}

function composeBaseUrl(relay) {
  if (!relay.host) return '';
  const proto = relay.proto || 'https';
  const port = Number(relay.port) || (proto === 'http' ? 80 : 443);
  const defaultPort = (proto === 'http' && port === 80) || (proto === 'https' && port === 443);
  return `${proto}://${relay.host}${defaultPort ? '' : `:${port}`}${relay.path || ''}`;
}

function headerValue(headers, wanted) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === wanted) return String(value);
  }
  return '';
}

function withoutHeader(headers, unwanted) {
  return Object.fromEntries(Object.entries(headers || {}).filter(
    ([name]) => name.toLowerCase() !== unwanted,
  ));
}

function preserveModelMapping(source, upstreamModels) {
  const upstreamByName = new Map(upstreamModels.map((model) => [model.toLowerCase(), model]));
  const previousModels = new Set(
    (Array.isArray(source?.models) ? source.models : []).map((model) => String(model).toLowerCase()),
  );
  const aliases = {};
  for (const [canonical, target] of Object.entries(source?.aliases || {})) {
    const upstream = upstreamByName.get(String(target).toLowerCase());
    if (upstream) aliases[canonical] = upstream;
  }
  const aliasNames = new Set(Object.keys(aliases).map((name) => name.toLowerCase()));
  const canonicalModels = [];
  const seen = new Set();
  const append = (name) => {
    const identity = String(name || '').trim().toLowerCase();
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    canonicalModels.push(String(name).trim());
  };
  const previousCanonical = Array.isArray(source?.canonicalModels)
    ? source.canonicalModels
    : Array.isArray(source?.models) ? source.models : [];
  for (const canonical of previousCanonical) {
    const identity = String(canonical).toLowerCase();
    if (upstreamByName.has(identity)) append(upstreamByName.get(identity));
    else if (aliasNames.has(identity)) append(canonical);
  }
  for (const upstream of upstreamModels) {
    if (!previousModels.has(upstream.toLowerCase())) append(upstream);
  }
  if (canonicalModels.length === 0) append(upstreamModels[0]);
  return { aliases, canonicalModels };
}

function credentialName(id) {
  return `tomato_tap_relay_${id}_key`;
}

function legacyCredentialName(id) {
  return `mimotap_relay_${id}_key`;
}

function proxyCredentialName(id) {
  return `tomato_tap_relay_${id}_proxy_url`;
}

function isStarterRelayDocument(document) {
  const entries = Object.entries(document.relays || {});
  return entries.length === 1 && entries[0][0] === 'example' && entries[0][1]?.disabled === true;
}

function isStarterModelDocument(document) {
  return Object.keys(document.realModels || {}).length === 1
    && Object.hasOwn(document.realModels || {}, 'example-model');
}
