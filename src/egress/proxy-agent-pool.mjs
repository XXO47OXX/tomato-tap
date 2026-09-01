import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export class ProxiedHttpsAgent extends https.Agent {
  constructor(agentOpts, proxyUrl) {
    super(agentOpts);
    const url = normalizeProxyUrl(proxyUrl);
    this.proxyProtocol = url.protocol;
    this.proxyHost = url.hostname;
    this.proxyPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  }

  createConnection(options, cb) {
    openTunnel(this, options, true, cb);
  }
}

export class ProxiedHttpAgent extends http.Agent {
  constructor(agentOpts, proxyUrl) {
    super(agentOpts);
    const url = normalizeProxyUrl(proxyUrl);
    this.proxyProtocol = url.protocol;
    this.proxyHost = url.hostname;
    this.proxyPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  }

  createConnection(options, cb) {
    openTunnel(this, options, false, cb);
  }
}

export function createProxyAgentPool({
  agentOptions = {},
  AgentClass,
  HttpAgentClass = ProxiedHttpAgent,
  HttpsAgentClass = AgentClass || ProxiedHttpsAgent,
} = {}) {
  const agents = new Map();
  return {
    get(proxyUrl, targetProtocol = 'https:') {
      if (targetProtocol !== 'http:' && targetProtocol !== 'https:') {
        throw new Error('proxy-agent-pool: target protocol must use http or https');
      }
      const normalized = normalizeProxyUrl(proxyUrl).toString();
      const cacheKey = `${targetProtocol}\0${normalized}`;
      let agent = agents.get(cacheKey);
      if (!agent) {
        const SelectedAgent = targetProtocol === 'http:' ? HttpAgentClass : HttpsAgentClass;
        agent = new SelectedAgent(agentOptions, normalized);
        agents.set(cacheKey, agent);
      }
      return agent;
    },
    size() { return agents.size; },
    destroy() {
      for (const agent of agents.values()) agent.destroy?.();
      agents.clear();
    },
  };
}

export function selectUpstreamAgent({
  targetProtocol,
  proxyUrl,
  dedicatedPool,
  useSharedProxy = false,
  sharedProxyUrl = '',
  sharedPool = dedicatedPool,
  directHttpAgent,
  directHttpsAgent,
}) {
  if (targetProtocol !== 'http:' && targetProtocol !== 'https:') {
    throw new Error('proxy-agent-pool: target protocol must use http or https');
  }
  if (proxyUrl) return dedicatedPool.get(proxyUrl, targetProtocol);
  if (useSharedProxy && sharedProxyUrl) return sharedPool.get(sharedProxyUrl, targetProtocol);
  return targetProtocol === 'http:' ? directHttpAgent : directHttpsAgent;
}

function openTunnel(agent, options, encryptTarget, cb) {
  const target = `${options.host}:${options.port || (encryptTarget ? 443 : 80)}`;
  const proxyClient = agent.proxyProtocol === 'https:' ? https : http;
  const proxyReq = proxyClient.request({
    host: agent.proxyHost,
    port: agent.proxyPort,
    method: 'CONNECT',
    path: target,
    headers: { Host: target },
    agent: false,
  });
  let completed = false;
  const finish = (error, socket) => {
    if (completed) {
      if (error && socket) socket.destroy();
      return;
    }
    completed = true;
    cb(error, socket);
  };
  proxyReq.once('connect', (res, socket, head) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      finish(new Error(`proxy CONNECT failed with HTTP ${res.statusCode}`));
      return;
    }
    if (head?.length) socket.unshift(head);
    if (!encryptTarget) {
      finish(null, socket);
      return;
    }
    const tlsSocket = tls.connect({
      socket,
      servername: options.servername || options.host,
      ALPNProtocols: ['http/1.1'],
    });
    const onError = (error) => finish(error);
    tlsSocket.once('error', onError);
    tlsSocket.once('secureConnect', () => {
      tlsSocket.removeListener('error', onError);
      finish(null, tlsSocket);
    });
  });
  proxyReq.once('error', (error) => finish(error));
  proxyReq.end();
}

function normalizeProxyUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('proxy-agent-pool: proxy URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('proxy-agent-pool: proxy URL credentials are not allowed');
  }
  return url;
}
