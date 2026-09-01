// Private configuration file primitives. Every generated file is owner-only,
// candidate documents are schema-validated before activation, and writes use
// same-directory atomic renames.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadRelayRegistry } from '../providers/relay-loader.mjs';
import { loadModelPolicy } from '../routing/model-policy.mjs';

export function ensureOperatorConfigFiles({
  relaysPath,
  modelsPath,
  seedRelaysPath,
  seedModelsPath,
}) {
  ensureSeededFile(relaysPath, seedRelaysPath);
  ensureSeededFile(modelsPath, seedModelsPath);
  return Object.freeze({ relaysPath, modelsPath });
}

export function validateCandidateDocuments(relaysPath, relays, modelsPath, models) {
  const relayCandidate = validationPath(relaysPath);
  const modelCandidate = validationPath(modelsPath);
  try {
    writePrivateFile(relayCandidate, `${JSON.stringify(relays, null, 2)}\n`);
    writePrivateFile(modelCandidate, `${JSON.stringify(models, null, 2)}\n`);
    loadRelayRegistry({ path: relayCandidate });
    loadModelPolicy({ path: modelCandidate });
  } finally {
    safeUnlink(relayCandidate);
    safeUnlink(modelCandidate);
  }
}

export function atomicWriteJson(path, document) {
  atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`);
}

export function updateEnvFile(path, changes) {
  const current = readOptional(path);
  const names = new Set(Object.keys(changes));
  const seen = new Set();
  const output = [];
  for (const line of current.split(/\r?\n/)) {
    // Relay slugs may contain dot or dash. They are valid in Tomato Tap's env
    // file even though an interactive shell cannot export them as identifiers.
    const match = line.match(/^\s*([^#\s=]+)\s*=/);
    if (!match || !names.has(match[1])) {
      if (line || output.length > 0) output.push(line);
      continue;
    }
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const value = changes[name];
    if (value != null && value !== '') output.push(`${name}=${value}`);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (seen.has(name) || value == null || value === '') continue;
    output.push(`${name}=${value}`);
  }
  while (output.at(-1) === '') output.pop();
  atomicWrite(path, `${output.join('\n')}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function redactPath(path) {
  const absolute = resolve(path);
  const segments = absolute.split('/').filter(Boolean);
  return segments.length <= 3 ? absolute : `…/${segments.slice(-3).join('/')}`;
}

function validationPath(path) {
  return `${path}.validate-${process.pid}-${randomUUID()}`;
}

function ensureSeededFile(path, seedPath) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, readFileSync(seedPath, 'utf8'));
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writePrivateFile(temporary, content);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    safeUnlink(temporary);
  }
}

function writePrivateFile(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function safeUnlink(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort cleanup */ }
}
