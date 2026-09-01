#!/usr/bin/env node

// Build the local pricing snapshot from Portkey-AI/models.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLegacyEnvAliases } from '../../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env);

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUTPUT = process.argv[2] || join(ROOT, 'pricing', 'portkey-model-prices.json');
const REPO_API = 'https://api.github.com/repos/Portkey-AI/models/contents/pricing';
const COMMITS_API = 'https://api.github.com/repos/Portkey-AI/models/commits?path=pricing&per_page=1';
const USER_AGENT = 'tomato-tap-model-pricing-sync/1.0';

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function centsPerTokenToPerMillion(price) {
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value * 10_000 : null;
}

function normalizePrice(raw) {
  const config = raw?.pricing_config?.pay_as_you_go;
  if (!config || typeof config !== 'object') return null;
  const input = centsPerTokenToPerMillion(config.request_token?.price);
  const output = centsPerTokenToPerMillion(config.response_token?.price);
  const inputCached = centsPerTokenToPerMillion(config.cache_read_input_token?.price);
  const inputCacheWrite = centsPerTokenToPerMillion(config.cache_write_input_token?.price);
  if (input === null && output === null && inputCached === null && inputCacheWrite === null) return null;
  return {
    currency: String(raw?.pricing_config?.currency || 'USD').toUpperCase(),
    unit: 'million_tokens',
    input: input ?? 0,
    inputCached: inputCached ?? input ?? 0,
    inputCacheWrite,
    output: output ?? 0,
  };
}

const [directory, commits] = await Promise.all([fetchJson(REPO_API), fetchJson(COMMITS_API)]);
const files = directory
  .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
  .sort((a, b) => a.name.localeCompare(b.name));

const providers = {};
let modelCount = 0;
await Promise.all(files.map(async (entry) => {
  const provider = entry.name.slice(0, -5);
  const raw = await fetchJson(entry.download_url);
  const models = {};
  for (const [model, value] of Object.entries(raw)) {
    if (model === 'default') continue;
    const price = normalizePrice(value);
    if (!price) continue;
    models[model] = price;
    modelCount++;
  }
  providers[provider] = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
}));

const output = {
  schemaVersion: 1,
  source: {
    name: 'Portkey-AI/models',
    repository: 'https://github.com/Portkey-AI/models',
    license: 'MIT',
    revision: String(commits?.[0]?.sha || ''),
    syncedAt: new Date().toISOString(),
    pricingUnitUpstream: 'cents_per_token',
    normalizedUnit: 'currency_per_million_tokens',
  },
  providers: Object.fromEntries(Object.entries(providers).sort(([a], [b]) => a.localeCompare(b))),
};

mkdirSync(dirname(OUTPUT), { recursive: true });
const temporary = `${OUTPUT}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(output, null, 2) + '\n');
renameSync(temporary, OUTPUT);
console.log(`wrote ${modelCount} token-priced models from ${files.length} providers to ${OUTPUT}`);
