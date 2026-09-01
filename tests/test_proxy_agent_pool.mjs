import assert from 'node:assert/strict';
import { createProxyAgentPool, selectUpstreamAgent } from '../src/egress/proxy-agent-pool.mjs';

const created = [];
class FakeAgent {
  constructor(options, proxyUrl) {
    this.options = options;
    this.proxyUrl = proxyUrl;
    created.push(this);
  }
}

const pool = createProxyAgentPool({
  agentOptions: { keepAlive: true, maxSockets: 4 },
  AgentClass: FakeAgent,
});

const first = pool.get('http://127.0.0.1:11001');
const same = pool.get('http://127.0.0.1:11001/');
const second = pool.get('http://127.0.0.1:11002');
assert.equal(first, same, 'normalized proxy URL reuses one Agent');
assert.notEqual(first, second, 'different key proxy URLs get different Agents');
assert.equal(created.length, 2);
assert.equal(first.proxyUrl, 'http://127.0.0.1:11001/');
assert.throws(() => pool.get('socks5://127.0.0.1:11001'), /http or https/);
assert.throws(() => pool.get('http://user:secret@127.0.0.1:11001'), /credentials/);

const directHttpAgent = { id: 'direct-http' };
const directHttpsAgent = { id: 'direct-https' };
const dedicatedCalls = [];
const dedicatedPool = {
  get(url, protocol) {
    dedicatedCalls.push({ url, protocol });
    return { id: `dedicated-${protocol}` };
  },
};
assert.equal(selectUpstreamAgent({
  targetProtocol: 'http:', proxyUrl: 'http://127.0.0.1:11001',
  dedicatedPool, directHttpAgent, directHttpsAgent,
}).id, 'dedicated-http:');
assert.deepEqual(dedicatedCalls, [{ url: 'http://127.0.0.1:11001', protocol: 'http:' }]);
assert.equal(selectUpstreamAgent({
  targetProtocol: 'http:', proxyUrl: '', dedicatedPool, directHttpAgent, directHttpsAgent,
}), directHttpAgent);

console.log('test_proxy_agent_pool: ok');
