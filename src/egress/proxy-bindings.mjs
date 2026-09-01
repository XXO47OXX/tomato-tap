import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

export class ProxyBindingUnavailableError extends Error {
  constructor(deploymentId, nodeId, localPort = null) {
    super(`proxy-bindings: bound proxy node ${nodeId || '(none)'} unavailable for ${deploymentId}`);
    this.name = 'ProxyBindingUnavailableError';
    this.code = 'BOUND_NODE_UNAVAILABLE';
    this.nodeId = nodeId || '';
    this.localPort = localPort;
  }
}

export function createBindingStore({ path, portStart = 11001, portEnd = 11999 }) {
  if (!path) throw new Error('proxy-bindings: path is required');
  if (!Number.isInteger(portStart) || !Number.isInteger(portEnd) || portStart > portEnd) {
    throw new Error('proxy-bindings: invalid port range');
  }
  let state = { schemaVersion: SCHEMA_VERSION, bindings: {} };

  function load() {
    if (!existsSync(path)) return snapshot();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.schemaVersion !== SCHEMA_VERSION || !parsed.bindings
        || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings)) {
      throw new Error('proxy-bindings: invalid state file');
    }
    validateBindings(parsed.bindings);
    state = { schemaVersion: SCHEMA_VERSION, bindings: { ...parsed.bindings } };
    return snapshot();
  }

  function resolve(deploymentId, policy, nodes) {
    const available = new Map((nodes || []).map((node) => [node.id, node]));
    if (!deploymentId || !policy || !['sticky', 'sticky-auto'].includes(policy.mode)) {
      throw new Error('proxy-bindings: sticky deployment and policy are required');
    }
    const current = state.bindings[deploymentId];
    let nodeId = current?.nodeId || null;
    if (policy.mode === 'sticky') nodeId = policy.nodeId;
    if (!nodeId) nodeId = rendezvousNode(deploymentId, [...available.keys()]);
    if (!nodeId) throw new ProxyBindingUnavailableError(deploymentId, '', current?.localPort);

    let localPort = current?.localPort || null;
    const bindingChanged = !current || current.nodeId !== nodeId;
    if (bindingChanged) {
      const existingNodeBinding = Object.values(state.bindings)
        .find((binding) => binding.nodeId === nodeId);
      const currentPortSharedByOldNode = current && Object.entries(state.bindings)
        .some(([id, binding]) => id !== deploymentId
          && binding.nodeId !== nodeId
          && binding.localPort === current.localPort);
      localPort = existingNodeBinding?.localPort
        || (current && !currentPortSharedByOldNode ? current.localPort : null)
        || allocatePort(state.bindings, portStart, portEnd);
    }
    if (!available.has(nodeId)) {
      if (policy.mode === 'sticky' && bindingChanged) {
        state.bindings[deploymentId] = { nodeId, localPort };
        persist();
      }
      throw new ProxyBindingUnavailableError(deploymentId, nodeId, localPort);
    }
    if (bindingChanged) {
      state.bindings[deploymentId] = { nodeId, localPort };
      persist();
    }
    return { nodeId, localPort };
  }

  function persist() {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return { load, resolve, snapshot };
}

function validateBindings(bindings) {
  const portOwners = new Map();
  const nodePorts = new Map();
  for (const [deploymentId, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding.nodeId !== 'string' || !binding.nodeId
        || !Number.isInteger(binding.localPort)) {
      throw new Error(`proxy-bindings: invalid binding for ${deploymentId}`);
    }
    const owner = portOwners.get(binding.localPort);
    if (owner && owner !== binding.nodeId) {
      throw new Error(`proxy-bindings: different nodes share local port ${binding.localPort}`);
    }
    const nodePort = nodePorts.get(binding.nodeId);
    if (nodePort && nodePort !== binding.localPort) {
      throw new Error(`proxy-bindings: node ${binding.nodeId} has multiple local ports`);
    }
    portOwners.set(binding.localPort, binding.nodeId);
    nodePorts.set(binding.nodeId, binding.localPort);
  }
}

function rendezvousNode(deploymentId, nodeIds) {
  let selected = null;
  let selectedScore = '';
  for (const nodeId of [...nodeIds].sort()) {
    const score = createHash('sha256').update(`${deploymentId}\0${nodeId}`).digest('hex');
    if (selected == null || score > selectedScore) {
      selected = nodeId;
      selectedScore = score;
    }
  }
  return selected;
}

function allocatePort(bindings, start, end) {
  const used = new Set(Object.values(bindings).map((binding) => binding.localPort));
  for (let port = start; port <= end; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`proxy-bindings: no free local port in ${start}-${end}`);
}
