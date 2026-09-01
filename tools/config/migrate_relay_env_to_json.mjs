// One-shot migration:
//   - read legacy flat relay metadata from .env
//   - write non-secret metadata to config/relays.json
//   - leave only tomato_tap_relay_<slug>_key secrets in .env

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLegacyEnvAliases } from '../../src/config/env-compat.mjs';

applyLegacyEnvAliases(process.env);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const projectEnvPath = join(root, '.env');
const envPath = process.env.TOMATO_TAP_ENV_FILE || projectEnvPath;
const relaysPath = process.env.TOMATO_TAP_RELAYS_PATH || join(root, 'config', 'relays.json');

const text = readFileSync(envPath, 'utf8');
const lines = text.split(/\n/);
const vars = new Map();

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  vars.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
}

const slugs = new Set();
for (const name of vars.keys()) {
  const m = name.match(/^(?:tomato_tap|mimotap)_relay_(.+?)_key$/i);
  if (m) slugs.add(m[1]);
}

const relays = {};
for (const slug of [...slugs].sort()) {
  const relayVar = (suffix) => vars.get(`tomato_tap_relay_${slug}_${suffix}`)
    ?? vars.get(`mimotap_relay_${slug}_${suffix}`);
  const host = relayVar('host');
  const path = relayVar('path');
  const models = splitCsv(relayVar('models'));
  const proto = relayVar('proto');
  const port = relayVar('port');
  const aliases = parseJsonObject(relayVar('aliases'));
  const disabled = truthy(relayVar('disabled'));
  const proxy = truthy(relayVar('proxy'));
  const cap = {};
  for (const field of ['initial', 'min', 'max']) {
    const raw = relayVar(`cap_${field}`);
    if (raw != null && raw !== '') cap[field] = Number(raw);
  }

  relays[slug] = {};
  if (host) relays[slug].host = host;
  if (path) relays[slug].path = path;
  if (models.length > 0) relays[slug].models = models;
  if (proto) relays[slug].proto = proto;
  if (port) relays[slug].port = Number(port);
  if (aliases) relays[slug].aliases = aliases;
  if (disabled) relays[slug].disabled = true;
  if (proxy) relays[slug].proxy = true;
  if (Object.keys(cap).length > 0) relays[slug].cap = cap;
}

const output = JSON.stringify({
  schemaVersion: 1,
  _doc: [
    'Non-secret relay metadata for tomato-tap.',
    `Secrets stay in ${envPath} as tomato_tap_relay_<slug>_key.`,
    'Each slug here pairs with that env key.'
  ],
  relays,
}, null, 2) + '\n';

if (existsSync(relaysPath)) {
  copyFileSync(relaysPath, `${relaysPath}.bak_${timestamp()}`);
}
writeFileSync(relaysPath, output);

copyFileSync(envPath, `${envPath}.bak_relay_json_${timestamp()}`);
const metadataLine = /^(\s*)(?:tomato_tap|mimotap)_relay_.+?_(host|path|models|proto|port|aliases|disabled|proxy|cap_initial|cap_min|cap_max)\s*=/i;
const newEnv = lines.filter((line) => !metadataLine.test(line)).join('\n');
writeFileSync(envPath, newEnv.endsWith('\n') ? newEnv : `${newEnv}\n`);

console.log(`migrated ${Object.keys(relays).length} relay metadata records to ${relaysPath}`);
console.log(`updated ${envPath}; backup created with .bak_relay_json_${timestamp(false)} suffix`);

function splitCsv(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function truthy(raw) {
  return ['1', 'true', 'yes'].includes(String(raw || '').trim().toLowerCase());
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('aliases must be a JSON object');
  }
  return parsed;
}

function timestamp(fresh = true) {
  const d = fresh ? new Date() : null;
  const x = d || new Date();
  return x.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}
