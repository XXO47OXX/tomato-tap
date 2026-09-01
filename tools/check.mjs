#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVendorFunctionRegistry } from '../src/providers/protocol-registry.mjs';
import { loadRelayRegistry } from '../src/providers/relay-loader.mjs';
import { loadVendors } from '../src/providers/vendor-loader.mjs';
import { loadModelPolicy } from '../src/routing/model-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRECTORIES = new Set(['.git', 'coverage', 'node_modules', 'runtime']);
const TEXT_EXTENSIONS = new Set(['', '.example', '.json', '.md', '.mjs', '.sh', '.yml', '.yaml']);
const errors = [];

const files = walk(ROOT).filter((path) => !path.includes(`${join(ROOT, 'pricing')}/portkey-model-prices.json`));

for (const path of files.filter((file) => extname(file) === '.mjs')) {
  const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (check.status !== 0) fail(path, check.stderr.trim() || 'syntax check failed');
}

for (const path of files.filter((file) => extname(file) === '.json')) {
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(path, `invalid JSON: ${error.message}`);
  }
}

validateImports();
validateConfiguration();
validateRepositoryBoundary();

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}

console.log(`repository check passed (${files.length} files)`);

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function validateImports() {
  const graph = new Map();
  for (const path of files.filter((file) => extname(file) === '.mjs')) {
    const source = readFileSync(path, 'utf8');
    const dependencies = [];
    const pattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const target = resolve(dirname(path), match[1]);
      if (!existsSync(target) || !statSync(target).isFile()) {
        fail(path, `unresolved import ${match[1]}`);
        continue;
      }
      dependencies.push(target);
      if (path.includes(`${join(ROOT, 'src')}/`)
          && !path.includes(`${join(ROOT, 'src', 'app')}/`)
          && target.includes(`${join(ROOT, 'src', 'app')}/`)) {
        fail(path, 'lower-level modules must not import src/app');
      }
    }
    graph.set(path, dependencies.filter((item) => graph.has(item) || item.includes(`${join(ROOT, 'src')}/`)));
  }
  detectCycles(graph);
}

function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (node, stack) => {
    if (visiting.has(node)) {
      fail(node, `import cycle: ${[...stack, node].map((item) => relative(ROOT, item)).join(' -> ')}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) || []) {
      if (graph.has(next)) visit(next, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node, []);
}

function validateConfiguration() {
  const config = join(ROOT, 'config');
  loadRelayRegistry({ path: join(config, 'relays.json') });
  loadRelayRegistry({ path: join(config, 'relays.example.json') });
  loadModelPolicy({ path: join(config, 'models.json') });
  loadVendors(createVendorFunctionRegistry(), { path: join(config, 'vendors.json') });

  for (const name of ['relays.json', 'relays.example.json']) {
    const document = JSON.parse(readFileSync(join(config, name), 'utf8'));
    for (const [deployment, metadata] of Object.entries(document.relays || {})) {
      if (metadata.host && !/(^|\.)example\.(com|net|org|invalid)$/.test(metadata.host)) {
        fail(join(config, name), `public relay ${deployment} must use an example domain`);
      }
    }
  }
}

function validateRepositoryBoundary() {
  const forbiddenFiles = ['.env', 'usage.log', 'budget.json', 'proxy.out'];
  for (const name of forbiddenFiles) {
    if (existsSync(join(ROOT, name))) fail(join(ROOT, name), 'runtime or secret file must not be committed');
  }

  const secretPatterns = [
    ['workstation path', /\/home\/administrator|\/mnt\/[a-z]\/Users\/|[A-Za-z]:\\Users\\/i],
    ['API key', /(?:sk|tp|ark|nvapi|cwk)[-_][A-Za-z0-9][A-Za-z0-9._-]{23,}/g],
    ['JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
    ['proxy URI', /(?:vless|trojan|hysteria2?|ss):\/\/[^\s'"`<>]+/gi],
  ];

  for (const path of files) {
    if (!TEXT_EXTENSIONS.has(extname(path))) continue;
    const rel = relative(ROOT, path);
    const source = readFileSync(path, 'utf8');
    for (const [label, pattern] of secretPatterns) {
      pattern.lastIndex = 0;
      if (label === 'proxy URI') {
        for (const match of source.matchAll(pattern)) {
          if (!isReservedExampleProxy(match[0])) fail(path, `possible ${label}`);
        }
      } else if (pattern.test(source)) {
        fail(path, `possible ${label}`);
      }
    }
  }
}

function isReservedExampleProxy(value) {
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

function fail(path, message) {
  errors.push(`${relative(ROOT, path)}: ${message}`);
}
