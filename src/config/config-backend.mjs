export const CONFIG_BACKENDS = Object.freeze(['auto', 'sqlite', 'files']);

export function normalizeConfigBackend(value, {
  defaultBackend = 'files',
  label = 'TOMATO_TAP_CONFIG_BACKEND',
} = {}) {
  const normalized = String(value || defaultBackend).trim().toLowerCase();
  if (!CONFIG_BACKENDS.includes(normalized)) {
    throw new Error(`${label} must be one of: ${CONFIG_BACKENDS.join(', ')}`);
  }
  return normalized;
}

export function selectConfigBackend({
  requested,
  registrySnapshot,
  defaultBackend = 'files',
  label = 'TOMATO_TAP_CONFIG_BACKEND',
} = {}) {
  const backend = normalizeConfigBackend(requested, { defaultBackend, label });
  if (backend === 'files') {
    return Object.freeze({ requested: backend, effective: 'files', registrySnapshot: null });
  }
  if (registrySnapshot?.active) {
    return Object.freeze({ requested: backend, effective: 'sqlite', registrySnapshot });
  }
  if (backend === 'sqlite') {
    throw new Error(`${label}=sqlite requires an active SQLite configuration registry`);
  }
  return Object.freeze({ requested: backend, effective: 'files', registrySnapshot: null });
}
