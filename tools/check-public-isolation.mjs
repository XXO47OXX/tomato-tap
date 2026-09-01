#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const files = releaseFiles();
const textExtensions = new Set(['', '.example', '.json', '.md', '.mjs', '.sh', '.yml', '.yaml']);
const excludedTextFiles = new Set([
  'pricing/portkey-model-prices.json',
  'tools/check-public-isolation.mjs',
]);

const forbiddenPaths = [
  /^\.env$/,
  /^config\/local\//,
  /^pricing\/local\//,
  /^runtime\//,
  /(?:^|\/)(?:usage\.log|budget\.json|proxy\.out)$/,
  /(?:^|\/).*(?:auth|credentials)\.json$/i,
];

const privateStrategyPatterns = [
  ['private client name', /\b(?:FGE|MVR)\b/i],
  ['private task alias', /short[_-]?banner|m2-short-banner|m6-grouped/i],
  [
    'private capability vocabulary',
    /fingerprint_generation|identity_grounding|product_disambiguation|conservative_judgment|independent_validation/i,
  ],
  ['private deployment identifier', /\b(?:arkcode|yuanshen)\b/i],
];

const credentialPatterns = [
  ['API key', /(?:sk|tp|ark|nvapi|cwk)[-_][A-Za-z0-9][A-Za-z0-9._-]{23,}/g],
  ['JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['credential URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/'"`<>]+/g],
  ['proxy URI', /(?:vless|trojan|hysteria2?|ss):\/\/[^\s'"`<>]+/gi],
];

for (const path of files) {
  for (const pattern of forbiddenPaths) {
    if (pattern.test(path)) errors.push(`${path}: private/runtime file is part of the release tree`);
  }
  if (!textExtensions.has(extname(path)) || excludedTextFiles.has(path)) continue;
  const source = readFileSync(resolve(ROOT, path), 'utf8');
  for (const [label, pattern] of privateStrategyPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) errors.push(`${path}: contains ${label}`);
  }
  for (const [label, pattern] of credentialPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (label === 'proxy URI' && reservedExampleProxy(match[0])) continue;
      if (label === 'credential URL' && reservedExampleCredentialUrl(match[0])) continue;
      errors.push(`${path}: possible ${label}`);
      break;
    }
  }
  if (/\/home\/administrator|\/mnt\/[a-z]\/Users\/Administrator|[A-Za-z]:\\Users\\Administrator/i.test(source)) {
    errors.push(`${path}: contains a workstation-specific path`);
  }
}

validateEmptyLocalPricing();
validateStarterConfiguration();

if (errors.length) {
  for (const error of [...new Set(errors)]) console.error(`ERROR ${error}`);
  process.exit(1);
}

console.log(`public isolation check passed (${files.length} release files)`);

function releaseFiles() {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    throw new Error(listed.stderr.trim() || 'git ls-files failed');
  }
  return listed.stdout.split('\0').filter(Boolean).sort();
}

function validateEmptyLocalPricing() {
  const path = 'pricing/overrides.json';
  const document = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
  if (Object.keys(document.aliases || {}).length || Object.keys(document.models || {}).length) {
    errors.push(`${path}: public local override template must remain empty`);
  }
}

function validateStarterConfiguration() {
  const relays = JSON.parse(readFileSync(resolve(ROOT, 'config/relays.json'), 'utf8'));
  for (const [id, relay] of Object.entries(relays.relays || {})) {
    const host = String(relay.host || '').toLowerCase();
    if (!/(^|\.)example\.(?:com|net|org|invalid)$/.test(host)) {
      errors.push(`config/relays.json: starter relay ${id} must use an example domain`);
    }
  }
}

function reservedExampleProxy(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'example.com'
      || host === 'example.net'
      || host === 'example.org'
      || host.endsWith('.example');
  } catch {
    return false;
  }
}

function reservedExampleCredentialUrl(value) {
  if (/^https?:\/\/(?:user|username):(?:pass|password|secret)@host(?::port)?/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const placeholderCredentials = ['user', 'username'].includes(url.username.toLowerCase())
      && ['pass', 'password', 'secret'].includes(url.password.toLowerCase());
    return placeholderCredentials && (
      host === 'host'
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.endsWith('.example')
    );
  } catch {
    return false;
  }
}
