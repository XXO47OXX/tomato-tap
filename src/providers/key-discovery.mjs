import { existsSync, readFileSync } from 'node:fs';

import { discoverRelayKeys } from './relay-loader.mjs';

export function buildKeyPool(config, { logger = console } = {}) {
  if (!config?.VENDORS || !config?.env || !config?.relayRegistry) {
    throw new TypeError('key discovery requires a complete runtime configuration');
  }
  const pool = [];
  for (const [vendorName, vendorConfig] of Object.entries(config.VENDORS)) {
    pool.push(...discoverKeysForVendor({
      vendorName,
      vendorConfig,
      env: config.env,
      relayRegistry: config.relayRegistry,
      logger,
    }));
  }
  return pool;
}

export function discoverKeysForVendor({
  vendorName,
  vendorConfig,
  env,
  relayRegistry,
  logger = console,
}) {
  if (vendorConfig.envDiscovery === 'multi') {
    return discoverRelayKeys(vendorName, vendorConfig.envPrefix, env, relayRegistry);
  }
  if (vendorConfig.envDiscovery === 'dump_file') {
    return discoverOAuthDumpKeys({ vendorName, vendorConfig, env, logger });
  }
  return discoverSingleValueKeys({ vendorName, vendorConfig, env });
}

function discoverSingleValueKeys({ vendorName, vendorConfig, env }) {
  return Object.keys(env)
    .filter((name) => vendorConfig.envPrefix.test(name) && !/_host$/i.test(name))
    .sort()
    .map((name, ordinal) => ({
      deploymentId: `${vendorName}-${ordinal + 1}`,
      providerLabel: vendorName,
      name,
      value: env[name],
      vendor: vendorName,
      host: env[`${name}_host`] || vendorConfig.defaultHost,
      pathPrefix: '',
      modelSet: null,
      nativeModels: vendorConfig.nativeModels || null,
    }))
    .filter((key) => typeof key.value === 'string' && key.value.length > 0);
}

function discoverOAuthDumpKeys({ vendorName, vendorConfig, env, logger }) {
  const pathVariable = vendorConfig.envDumpPath;
  const path = pathVariable ? env[pathVariable] : '';
  if (!path) {
    logger.warn(
      `[${vendorName}-discover] no dump path set (env=${pathVariable || '(unset)'})`,
    );
    return [];
  }
  if (!existsSync(path)) {
    logger.warn(`[${vendorName}-discover] dump file missing: ${path}`);
    return [];
  }

  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    logger.warn(`[${vendorName}-discover] failed to parse ${path}: ${error.message}`);
    return [];
  }

  const accounts = Array.isArray(document.accounts) ? document.accounts : [];
  const keys = [];
  const seenTokens = new Set();
  for (const account of accounts) {
    if (!account || account.platform !== 'openai' || account.type !== 'oauth') continue;
    const credentials = account.credentials || {};
    const token = credentials.access_token;
    const accountId = credentials.chatgpt_account_id;
    if (typeof token !== 'string' || typeof accountId !== 'string' || !token || !accountId) {
      continue;
    }
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    const slug = String(account.name || accountId)
      .replace(/[^a-z0-9._-]+/gi, '_')
      .slice(0, 64);
    keys.push({
      deploymentId: `${vendorName}-${keys.length + 1}`,
      providerLabel: vendorName,
      name: `${vendorName}_${slug}`,
      value: token,
      vendor: vendorName,
      host: vendorConfig.defaultHost,
      pathPrefix: '',
      modelSet: null,
      chatgptAccountId: accountId,
    });
  }
  logger.log(`[${vendorName}-discover] loaded ${keys.length} keys from ${path}`);
  return keys;
}
