export const ENV_PREFIX = 'TOMATO_TAP_';
export const LEGACY_ENV_PREFIX = 'MIMO_TAP_';

// Keep pre-rename deployments working while all new configuration uses the
// Tomato Tap prefix. Canonical variables always win when both names exist.
export function applyLegacyEnvAliases(
  env = process.env,
  { logger = console, warn = false } = {},
) {
  const aliases = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) continue;
    const canonicalName = `${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[canonicalName] !== undefined) continue;
    env[canonicalName] = value;
    aliases.push({ legacyName: name, canonicalName });
  }
  if (warn && aliases.length > 0) {
    logger.warn?.(
      `[tomato-tap] loaded ${aliases.length} deprecated MIMO_TAP_* variable(s); `
      + 'rename them to TOMATO_TAP_* before 1.0',
    );
  }
  return aliases;
}

export function relayCredential(env, deploymentId) {
  const suffix = String(deploymentId || '').trim();
  if (!suffix) return undefined;
  return env[`tomato_tap_relay_${suffix}_key`]
    ?? env[`mimotap_relay_${suffix}_key`];
}

export function canonicalCredentialName(name) {
  return String(name || '')
    .replace(/^mimotap_/i, 'tomato_tap_');
}
