import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Preserve legacy root-level state; use runtime/ for new installations.
export function resolveStateLayout(rootDir, env = process.env) {
  if (!rootDir) throw new Error('state-layout: rootDir is required');
  const root = resolve(rootDir);
  const explicitStateDir = String(env.TOMATO_TAP_STATE_DIR || '').trim();
  const legacyDetected = !explicitStateDir && hasLegacyState(root);
  const stateDir = explicitStateDir
    ? resolve(explicitStateDir)
    : legacyDetected
      ? root
      : join(root, 'runtime');
  const explicitRuntimeDir = String(env.TOMATO_TAP_RUNTIME_DIR || '').trim();
  const runtimeDir = explicitRuntimeDir
    ? resolve(explicitRuntimeDir)
    : (explicitStateDir || legacyDetected)
      ? join(stateDir, 'runtime')
      : stateDir;
  return Object.freeze({
    rootDir: root,
    stateDir,
    runtimeDir,
    legacyLayout: legacyDetected,
    explicit: !!explicitStateDir,
  });
}

function hasLegacyState(root) {
  return ['usage.log', 'budget.json', 'samples'].some((name) => existsSync(join(root, name)));
}
