import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CATALOG_PATH = join(PROJECT_ROOT, 'pricing', 'portkey-model-prices.json');
const DEFAULT_PROVIDER_OVERRIDES_PATH = join(PROJECT_ROOT, 'pricing', 'provider-defaults.json');
const DEFAULT_OVERRIDES_PATH = resolve(
  process.env.TOMATO_TAP_PRICING_OVERRIDES_PATH
    || process.env.MIMO_TAP_PRICING_OVERRIDES_PATH
    || join(PROJECT_ROOT, 'pricing', 'overrides.json'),
);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function tailName(value) {
  return normalized(value).split('/').at(-1) || '';
}

function positiveOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isWeekendAtUtcOffset(at = new Date(), offsetMinutes = 0) {
  const timestamp = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const offset = Number(offsetMinutes);
  if (!Number.isFinite(timestamp) || !Number.isFinite(offset)) return false;
  const localDay = new Date(timestamp + offset * 60_000).getUTCDay();
  return localDay === 0 || localDay === 6;
}

function compileOverride(raw, model, layer = 'local-override') {
  if (!raw || typeof raw !== 'object') return null;
  const input = positiveOrZero(raw.input);
  const output = positiveOrZero(raw.output);
  if (input === null && output === null) return null;
  const effectiveFromMs = raw.effectiveFrom ? Date.parse(raw.effectiveFrom) : null;
  const costMode = raw.costMode === 'accounted' ? 'accounted' : 'estimated';
  return Object.freeze({
    model,
    provider: layer,
    currency: String(raw.currency || 'USD').toUpperCase(),
    unit: 'million_tokens',
    input: input ?? 0,
    inputCached: positiveOrZero(raw.inputCached) ?? input ?? 0,
    inputCacheWrite: positiveOrZero(raw.inputCacheWrite),
    output: output ?? 0,
    peak: raw.peak && typeof raw.peak === 'object' ? {
      input: positiveOrZero(raw.peak.input) ?? input ?? 0,
      inputCached: positiveOrZero(raw.peak.inputCached) ?? positiveOrZero(raw.peak.input) ?? input ?? 0,
      inputCacheWrite: positiveOrZero(raw.peak.inputCacheWrite),
      output: positiveOrZero(raw.peak.output) ?? output ?? 0,
    } : null,
    peakHoursUtc: Array.isArray(raw.peakHoursUtc) ? raw.peakHoursUtc : [],
    offPeakWeekends: raw.offPeakWeekends === true,
    billingUtcOffsetMinutes: Number.isFinite(Number(raw.billingUtcOffsetMinutes))
      ? Number(raw.billingUtcOffsetMinutes)
      : 0,
    effectiveFrom: Number.isFinite(effectiveFromMs) ? String(raw.effectiveFrom) : '',
    effectiveFromMs: Number.isFinite(effectiveFromMs) ? effectiveFromMs : null,
    previous: raw.previous && typeof raw.previous === 'object'
      ? compileOverride(raw.previous, model, layer)
      : null,
    costMode,
    source: String(
      raw.source || (layer === 'provider-default'
        ? 'Tomato Tap public provider defaults'
        : 'Tomato Tap local override'),
    ),
    sourceUrl: String(raw.sourceUrl || ''),
    asOf: String(raw.asOf || ''),
  });
}

const FAMILY_PROVIDER = [
  [/^(gpt-|o\d|chatgpt|codex)/, 'openai'],
  [/^claude-/, 'anthropic'],
  [/^grok-/, 'x-ai'],
  [/^deepseek-/, 'deepseek'],
  [/^glm-/, 'z-ai'],
  [/^(kimi-|moonshot-)/, 'moonshot'],
  [/^minimax-/, 'minimax'],
  [/^(qwen|qwq|qvq)/, 'dashscope'],
  [/^(doubao-|seed-)/, 'byteplus'],
];

function preferredProvider(model) {
  const name = tailName(model);
  return FAMILY_PROVIDER.find(([pattern]) => pattern.test(name))?.[1] || '';
}

function inPeakWindow(price, at) {
  if (!price.peak || price.peakHoursUtc.length === 0) return false;
  if (price.offPeakWeekends
      && isWeekendAtUtcOffset(at, price.billingUtcOffsetMinutes)) return false;
  const hour = at.getUTCHours();
  return price.peakHoursUtc.some(([start, end]) => hour >= Number(start) && hour < Number(end));
}

function effectiveOverride(price, at) {
  while (price?.previous && price.effectiveFromMs !== null && at.getTime() < price.effectiveFromMs) {
    price = price.previous;
  }
  if (!inPeakWindow(price, at)) return price;
  return { ...price, ...price.peak, priceBand: 'peak' };
}

export function createModelPricing({
  catalog,
  overrides,
  providerOverrides,
  catalogPath,
  overridesPath,
  providerOverridesPath,
} = {}) {
  const rawCatalog = catalog || readJson(catalogPath || DEFAULT_CATALOG_PATH, {
    schemaVersion: 1,
    source: {},
    providers: {},
  });
  const publicOverrides = providerOverrides || readJson(
    providerOverridesPath || DEFAULT_PROVIDER_OVERRIDES_PATH,
    { schemaVersion: 1, aliases: {}, models: {} },
  );
  const localOverrides = overrides || readJson(overridesPath || DEFAULT_OVERRIDES_PATH, {
    schemaVersion: 1,
    aliases: {},
    models: {},
  });
  const aliases = new Map(
    Object.entries({
      ...(publicOverrides.aliases || {}),
      ...(localOverrides.aliases || {}),
    }).map(([from, to]) => [normalized(from), normalized(to)]),
  );
  const local = new Map();
  for (const [model, value] of Object.entries(publicOverrides.models || {})) {
    const compiled = compileOverride(value, normalized(model), 'provider-default');
    if (compiled) local.set(normalized(model), compiled);
  }
  for (const [model, value] of Object.entries(localOverrides.models || {})) {
    const compiled = compileOverride(value, normalized(model), 'local-override');
    if (compiled) local.set(normalized(model), compiled);
  }

  const exact = new Map();
  const byTail = new Map();
  let catalogEntries = 0;
  for (const [provider, models] of Object.entries(rawCatalog.providers || {})) {
    for (const [model, price] of Object.entries(models || {})) {
      if (!price || typeof price !== 'object') continue;
      const entry = Object.freeze({
        ...price,
        model,
        provider,
        source: 'Portkey-AI/models',
        sourceUrl: `https://github.com/Portkey-AI/models/blob/main/pricing/${provider}.json`,
        asOf: String(rawCatalog.source?.syncedAt || ''),
      });
      const full = normalized(model);
      const tail = tailName(model);
      if (!exact.has(full)) exact.set(full, []);
      exact.get(full).push(entry);
      if (!byTail.has(tail)) byTail.set(tail, []);
      byTail.get(tail).push(entry);
      catalogEntries++;
    }
  }

  function canonicalize(model) {
    let current = normalized(model);
    const seen = new Set();
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current);
    }
    return current;
  }

  function resolve(model, { at = new Date() } = {}) {
    const requested = normalized(model);
    if (!requested) return null;
    const canonical = canonicalize(requested);
    const localPrice = local.get(canonical) || local.get(tailName(canonical));
    if (localPrice) {
      return Object.freeze({
        ...effectiveOverride(localPrice, at),
        requestedModel: model,
        canonicalModel: canonical,
      });
    }

    const names = [...new Set([requested, canonical])];
    const candidates = [];
    for (const name of names) {
      for (const entry of exact.get(name) || []) candidates.push(entry);
      for (const entry of byTail.get(tailName(name)) || []) candidates.push(entry);
    }
    if (candidates.length === 0) return null;

    const preferred = preferredProvider(canonical);
    const requestedHasProvider = requested.includes('/');
    const requestedFree = requested.endsWith(':free') || requested.includes('-free');
    const unique = [...new Map(candidates.map((entry) => [`${entry.provider}\0${entry.model}`, entry])).values()];
    unique.sort((a, b) => {
      const score = (entry) => {
        const full = normalized(entry.model);
        let value = 0;
        // Provider-qualified names take precedence over family heuristics.
        if (full === requested || full === canonical) {
          value += requestedHasProvider ? (full === requested ? 500 : 450) : 100;
        }
        if (tailName(full) === tailName(canonical)) value += 100;
        if (!requestedHasProvider && entry.provider === preferred) value += 250;
        if (requestedHasProvider && entry.provider === 'openrouter') value += 180;
        // OpenRouter is the fallback for unqualified open-weight models.
        if (!requestedHasProvider && entry.provider === 'openrouter') value += 150;
        const entryFree = full.endsWith(':free');
        if (entryFree === requestedFree) value += 30;
        else if (entryFree) value -= 50;
        return value;
      };
      return score(b) - score(a) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    });
    const selected = unique[0];
    return Object.freeze({
      ...selected,
      requestedModel: model,
      canonicalModel: canonical,
    });
  }

  function estimate(entry, { at } = {}) {
    const input = Math.max(0, Number(entry?.input) || 0);
    const output = Math.max(0, Number(entry?.output) || 0);
    const inputCached = Math.min(input, Math.max(0, Number(entry?.inputCached ?? entry?.input_cached) || 0));
    const inputMiss = Math.max(0, Number(entry?.inputMiss ?? entry?.input_miss ?? (input - inputCached)) || 0);
    const effectiveAt = at || new Date(entry?._at || entry?.ts || Date.now());
    const stored = entry?.pricing && typeof entry.pricing === 'object' ? entry.pricing : null;
    const storedInput = positiveOrZero(stored?.input);
    const storedOutput = positiveOrZero(stored?.output);
    const storedPrice = stored && (storedInput !== null || storedOutput !== null)
      ? {
          model: stored.catalog_model || entry?.model || '',
          canonicalModel: stored.canonical_model || entry?.model || '',
          provider: stored.provider || '',
          currency: String(stored.currency || 'USD').toUpperCase(),
          unit: stored.unit || 'million_tokens',
          input: storedInput ?? 0,
          inputCached: positiveOrZero(stored.input_cached) ?? storedInput ?? 0,
          inputCacheWrite: positiveOrZero(stored.input_cache_write),
          output: storedOutput ?? 0,
          source: stored.source || 'usage.log price snapshot',
          asOf: stored.as_of || '',
          priceBand: stored.price_band || 'standard',
          costMode: stored.cost_mode === 'accounted' ? 'accounted' : 'estimated',
        }
      : null;
    const resolved = resolve(entry?.model, { at: effectiveAt });
    // Correct legacy weekend peak snapshots without repricing other rows.
    const historicalWeekendPeak = storedPrice?.priceBand === 'peak'
      && resolved?.offPeakWeekends === true
      && isWeekendAtUtcOffset(effectiveAt, resolved.billingUtcOffsetMinutes);
    const staleDatedSnapshot = storedPrice
      && ['local-override', 'provider-default'].includes(resolved?.provider)
      && resolved.provider === storedPrice.provider
      && resolved.effectiveFromMs !== null
      && effectiveAt.getTime() >= resolved.effectiveFromMs
      && (
        Number(storedPrice.input) !== Number(resolved.input)
        || Number(storedPrice.inputCached) !== Number(resolved.inputCached)
        || Number(storedPrice.output) !== Number(resolved.output)
      );
    const price = historicalWeekendPeak || staleDatedSnapshot
      ? resolved
      : (storedPrice || resolved);
    if (!price) return { priced: false, amount: 0, currency: '', price: null };
    const amount = (
      inputMiss * Number(price.input || 0)
      + inputCached * Number(price.inputCached ?? price.input ?? 0)
      + output * Number(price.output || 0)
    ) / 1_000_000;
    return { priced: true, amount, currency: price.currency, price };
  }

  function snapshot(model, { at = new Date() } = {}) {
    const price = resolve(model, { at });
    if (!price) return null;
    return {
      source: price.source,
      provider: price.provider,
      catalog_model: price.model,
      canonical_model: price.canonicalModel,
      currency: price.currency,
      unit: price.unit,
      input: price.input,
      input_cached: price.inputCached,
      input_cache_write: price.inputCacheWrite,
      output: price.output,
      price_band: price.priceBand || 'standard',
      cost_mode: price.costMode === 'accounted' ? 'accounted' : 'estimated',
      off_peak_weekends: price.offPeakWeekends === true,
      billing_utc_offset_minutes: Number(price.billingUtcOffsetMinutes || 0),
      effective_from: price.effectiveFrom || '',
      as_of: price.asOf,
    };
  }

  function stats(models = []) {
    const unique = [...new Set(models.map(normalized).filter(Boolean))];
    const priced = unique.filter((model) => resolve(model));
    return {
      configured: unique.length,
      priced: priced.length,
      unpriced: unique.length - priced.length,
      coverage: unique.length ? priced.length / unique.length : 1,
      catalogEntries,
      source: rawCatalog.source || {},
    };
  }

  return Object.freeze({ resolve, estimate, snapshot, stats, canonicalize });
}

export const MODEL_PRICING = createModelPricing();

export function formatUnitPrice(price) {
  if (!price) return '未公开';
  const symbol = price.currency === 'CNY' ? '¥' : price.currency === 'USD' ? '$' : `${price.currency} `;
  const number = (value) => `${symbol}${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
  return {
    input: number(price.input),
    inputCached: number(price.inputCached ?? price.input),
    output: number(price.output),
    suffix: '/百万 token',
  };
}
