import assert from 'node:assert/strict';
import { parseProxySubscription, redactProxyNode } from '../src/egress/proxy-subscription.mjs';

const VLESS = 'vless://';
const SHADOWSOCKS = 'ss://';
const first = `${VLESS}11111111-1111-4111-8111-111111111111@one.example:443?security=tls&type=ws&path=%2Fedge&sni=one.example#Tokyo`;
const duplicate = `${VLESS}11111111-1111-4111-8111-111111111111@one.example:443?type=ws&sni=one.example&path=%2Fedge&security=tls#Duplicate`;
const second = `${VLESS}22222222-2222-4222-8222-222222222222@two.example:8443?security=none&type=tcp#台北`;
const ssCredentials = Buffer.from('aes-128-gcm:secret-password').toString('base64url');
const shadowsocks = `${SHADOWSOCKS}${ssCredentials}@ss.example:8388#Shadowsocks`;
const socks = 'socks5://proxy-user:proxy-pass@socks.example:1080';
const encoded = Buffer.from([first, duplicate, 'not-a-uri', second, shadowsocks, socks].join('\n')).toString('base64');

const nodes = parseProxySubscription(encoded);
assert.equal(nodes.length, 4, 'supported nodes are parsed while duplicates and malformed records are removed');
assert.equal(nodes[0].protocol, 'vless');
assert.equal(nodes[0].server, 'one.example');
assert.equal(nodes[0].port, 443);
assert.equal(nodes[0].transport, 'ws');
assert.equal(nodes[0].tls.security, 'tls');
assert.equal('rawUri' in nodes[0], false, 'runtime nodes must not retain credential-bearing URIs');
assert.equal(nodes[1].transport, 'tcp');
assert.equal(nodes[2].protocol, 'shadowsocks');
assert.equal(nodes[2].server, 'ss.example');
assert.equal(nodes[2].port, 8388);
assert.equal(nodes[2].method, 'aes-128-gcm');
assert.equal(nodes[2].password, 'secret-password');
assert.equal('rawUri' in nodes[2], false);
assert.equal(nodes[3].protocol, 'socks5');
assert.equal(nodes[3].server, 'socks.example');
assert.equal(nodes[3].port, 1080);
assert.equal(nodes[3].username, 'proxy-user');
assert.equal(nodes[3].password, 'proxy-pass');

const plainNodes = parseProxySubscription(first);
assert.equal(plainNodes.length, 1, 'plain URI input is accepted');
assert.equal(plainNodes[0].id, nodes[0].id, 'node ID is deterministic');

const redacted = JSON.stringify(redactProxyNode(nodes[0]));
assert(!redacted.includes('11111111-1111-4111-8111-111111111111'));
assert(!redacted.includes('one.example'));
assert(!redacted.includes(VLESS));
assert.equal(redactProxyNode(nodes[0]).id, nodes[0].id);
const redactedSs = JSON.stringify(redactProxyNode(nodes[2]));
assert(!redactedSs.includes('secret-password'));
assert(!redactedSs.includes('ss.example'));
const redactedSocks = JSON.stringify(redactProxyNode(nodes[3]));
assert(!redactedSocks.includes('proxy-user'));
assert(!redactedSocks.includes('proxy-pass'));
assert(!redactedSocks.includes('socks.example'));

const legacyPayload = Buffer.from('aes-256-gcm:legacy-secret@legacy.example:9443').toString('base64url');
const legacy = parseProxySubscription(`${SHADOWSOCKS}${legacyPayload}#Legacy`);
assert.equal(legacy.length, 1);
assert.equal(legacy[0].protocol, 'shadowsocks');
assert.equal(legacy[0].server, 'legacy.example');
assert.equal(legacy[0].method, 'aes-256-gcm');

const clashYaml = `
proxies:
  - client-fingerprint: chrome
    flow: xtls-rprx-vision
    name: reality-node
    network: tcp
    port: 443
    reality-opts:
      public-key: public-key-value
      short-id: abc123
    server: reality.example
    servername: www.example.com
    tls: true
    type: vless
    uuid: 33333333-3333-4333-8333-333333333333
  - encryption: none
    name: websocket-node
    network: ws
    port: 8443
    server: websocket.example
    tls: true
    type: vless
    uuid: 44444444-4444-4444-8444-444444444444
    ws-opts:
      headers:
        Host: edge.example
      path: /edge
  - name: unsupported
    port: 443
    server: ignored.example
    type: vmess
    uuid: 55555555-5555-4555-8555-555555555555
`;
const clashNodes = parseProxySubscription(clashYaml);
assert.equal(clashNodes.length, 2, 'supported VLESS nodes are extracted from Clash YAML');
assert.equal(clashNodes[0].tls.security, 'reality');
assert.equal(clashNodes[0].params.pbk, 'public-key-value');
assert.equal(clashNodes[0].params.sid, 'abc123');
assert.equal(clashNodes[0].params.flow, 'xtls-rprx-vision');

const clashInlineNodes = parseProxySubscription(`
proxies:
  - {name: "Inline, VLESS", server: edge.example.com, port: 443, type: vless, uuid: 431fe973-a43a-4fac-bf83-2a772e0d0625, network: tcp, tls: true, servername: www.example.com, client-fingerprint: chrome, reality-opts: {public-key: public-key, short-id: 0123456789abcdef}, flow: xtls-rprx-vision}
  - {name: Inline SS, server: 203.0.113.8, port: 8388, type: ss, cipher: aes-256-gcm, password: "secret,with,commas"}
  - {name: Unsupported, server: edge.example.com, port: 443, type: trojan, password: secret}
`);
assert.equal(clashInlineNodes.length, 2);
assert.equal(clashInlineNodes[0].protocol, 'vless');
assert.equal(clashInlineNodes[0].params.pbk, 'public-key');
assert.equal(clashInlineNodes[0].params.sid, '0123456789abcdef');
assert.equal(clashInlineNodes[1].protocol, 'shadowsocks');
assert.equal(clashInlineNodes[1].password, 'secret,with,commas');
assert.equal(clashNodes[1].transport, 'ws');
assert.equal(clashNodes[1].params.path, '/edge');
assert.equal(clashNodes[1].params.host, 'edge.example');

assert.deepEqual(parseProxySubscription(''), []);
console.log('test_proxy_subscription: ok');
