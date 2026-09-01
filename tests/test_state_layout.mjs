import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveStateLayout } from '../src/config/state-layout.mjs';

test('new installs use one runtime directory for all mutable state', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimo-state-new-'));
  try {
    const layout = resolveStateLayout(root, {});
    assert.equal(layout.stateDir, join(root, 'runtime'));
    assert.equal(layout.runtimeDir, join(root, 'runtime'));
    assert.equal(layout.legacyLayout, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing root ledger selects the backward-compatible layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimo-state-old-'));
  try {
    writeFileSync(join(root, 'usage.log'), '');
    const layout = resolveStateLayout(root, {});
    assert.equal(layout.stateDir, root);
    assert.equal(layout.runtimeDir, join(root, 'runtime'));
    assert.equal(layout.legacyLayout, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit state and runtime paths remain authoritative', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimo-state-explicit-'));
  try {
    const layout = resolveStateLayout(root, {
      TOMATO_TAP_STATE_DIR: join(root, 'data'),
      TOMATO_TAP_RUNTIME_DIR: join(root, 'volatile'),
    });
    assert.equal(layout.stateDir, join(root, 'data'));
    assert.equal(layout.runtimeDir, join(root, 'volatile'));
    assert.equal(layout.explicit, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
