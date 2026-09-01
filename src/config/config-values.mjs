// Strict parsers for environment-backed limits.

export function parseBoolean(value, name, { defaultValue = false } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  throw new Error(`${name} must be true/false (or 1/0)`);
}

export function parseDuration(value, name, { minMs = 1_000 } = {}) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) throw new Error(`${name} must be a duration such as 30s, 10m, or 7d`);
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * unitMs[match[2].toLowerCase()];
  if (!Number.isFinite(result) || result < minMs) {
    throw new Error(`${name} must be at least ${minMs}ms`);
  }
  return Math.round(result);
}

export function parseSize(value, name, { minBytes = 1 } = {}) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)$/i);
  if (!match) throw new Error(`${name} must be a size such as 32MiB or 1GiB`);
  const multipliers = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000 ** 2,
    mib: 1_024 ** 2,
    gb: 1_000 ** 3,
    gib: 1_024 ** 3,
  };
  const result = Number(match[1]) * multipliers[match[2].toLowerCase()];
  if (!Number.isFinite(result) || result < minBytes) {
    throw new Error(`${name} must be at least ${minBytes} bytes`);
  }
  return Math.round(result);
}

export function parseInteger(value, name, { defaultValue, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw && defaultValue !== undefined) return defaultValue;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return result;
}
