import assert from 'node:assert/strict';
import { parseProxySubscription, redactProxyNode } from '../src/egress/proxy-subscription.mjs';

const first = 'vless://11111111-1111-4111-8111-111111111111@one.example:443?security=tls&type=ws&path=%2Fedge&sni=one.example#Tokyo';
const duplicate = 'vless://11111111-1111-4111-8111-111111111111@one.example:443?type=ws&sni=one.example&path=%2Fedge&security=tls#Duplicate';
const second = 'vless://22222222-2222-4222-8222-222222222222@two.example:8443?security=none&type=tcp#台北';
const encoded = Buffer.from([first, duplicate, 'not-a-uri', second].join('\n')).toString('base64');

const nodes = parseProxySubscription(encoded);
assert.equal(nodes.length, 2, 'duplicates and malformed records are removed');
assert.equal(nodes[0].protocol, 'vless');
assert.equal(nodes[0].server, 'one.example');
assert.equal(nodes[0].port, 443);
assert.equal(nodes[0].transport, 'ws');
assert.equal(nodes[0].tls.security, 'tls');
assert.equal('rawUri' in nodes[0], false, 'runtime nodes must not retain credential-bearing URIs');
assert.equal(nodes[1].transport, 'tcp');

const plainNodes = parseProxySubscription(first);
assert.equal(plainNodes.length, 1, 'plain URI input is accepted');
assert.equal(plainNodes[0].id, nodes[0].id, 'node ID is deterministic');

const redacted = JSON.stringify(redactProxyNode(nodes[0]));
assert(!redacted.includes('11111111-1111-4111-8111-111111111111'));
assert(!redacted.includes('one.example'));
assert(!redacted.includes('vless://'));
assert.equal(redactProxyNode(nodes[0]).id, nodes[0].id);

assert.deepEqual(parseProxySubscription(''), []);
console.log('test_proxy_subscription: ok');
