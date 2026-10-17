import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createNetworkPolicy } from '../server/network.mjs';

const fixture = () => ({
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '193.168.10.144', family: 'IPv4', internal: false }, { address: 'fe80::1234', family: 'IPv6', internal: false }],
  utun0: [{ address: '100.64.10.5', family: 'IPv4', internal: false }],
});
const policy = options => createNetworkPolicy({ port: 4173, getInterfaces: fixture, getHostname: () => 'Hugo-MacBook.local', ...options });

test('LAN access allows actual interfaces even outside RFC1918, and only this machine aliases', () => {
  const network = policy();
  for (const host of ['localhost:4173', '127.0.0.1:4173', '193.168.10.144:4173', '100.64.10.5:4173', 'hugo-macbook.local:4173', 'Hugo-MacBook:4173']) assert.equal(network.allowsHost(host), true, host);
  for (const host of ['192.168.1.2:4173', '193.168.10.145:4173', 'example.com:4173', 'evil.local:4173', '0.0.0.0:4173', '[::1]:4173']) assert.equal(network.allowsHost(host), false, host);
});

test('Host validation rejects DNS-rebinding names, parser tricks, missing and wrong ports', () => {
  const network = policy();
  for (const host of [undefined, '', 'localhost', 'localhost:80', 'localhost:04173', 'localhost:4174', 'localhost:99999', ' localhost:4173', 'localhost:4173 ', 'localhost:4173\r\nX-Test: yes', 'localhost:4173.evil.test', 'localhost.evil.test:4173', 'localhost.:4173', 'localhost:4173@evil.test', 'evil.test@localhost:4173', 'localhost:4173/path', 'localhost:4173#fragment', 'localhost:4173,evil.test', '2130706433:4173', '0x7f000001:4173', '127.1:4173']) assert.equal(network.allowsHost(host), false, String(host));
});

test('network changes update the exact address allowlist without restarting the service', () => {
  let interfaces = fixture();
  const network = policy({ getInterfaces: () => interfaces });
  assert.equal(network.allowsHost('193.168.10.144:4173'), true);
  interfaces = { en1: [{ address: '10.2.3.4', family: 4, internal: false }] };
  assert.equal(network.allowsHost('193.168.10.144:4173'), false);
  assert.equal(network.allowsHost('10.2.3.4:4173'), true);
});

test('POST origin must match the current allowed request Host, not just another local address', () => {
  const network = policy();
  assert.equal(network.allowsOrigin('http://193.168.10.144:4173', '193.168.10.144:4173'), true);
  assert.equal(network.allowsOrigin('http://hugo-macbook.local:4173', 'Hugo-MacBook.local:4173'), true);
  assert.equal(network.allowsOrigin(undefined, 'localhost:4173'), true);
  for (const origin of ['http://localhost:4173', 'http://127.0.0.1:4173', 'http://evil.test:4173', 'https://193.168.10.144:4173', 'http://193.168.10.144:4173/', 'http://193.168.10.144:4173/path', 'http://user@193.168.10.144:4173', 'http://193.168.10.144:4173#x', 'null', '', ['http://193.168.10.144:4173']]) assert.equal(network.allowsOrigin(origin, '193.168.10.144:4173'), false, String(origin));
  assert.equal(network.allowsOrigin('http://evil.test:4173', 'evil.test:4173'), false);
});

test('startup URLs list LAN interfaces for wildcard binding and omit them for local-only binding', () => {
  assert.deepEqual(policy().urls(), { local: 'http://localhost:4173/', lanName: 'http://hugo-macbook.local:4173/', lan: ['http://193.168.10.144:4173/', 'http://100.64.10.5:4173/'] });
  assert.deepEqual(policy({ bindHost: '127.0.0.1' }).urls(), { local: 'http://localhost:4173/', lanName: null, lan: [] });
  assert.deepEqual(policy({ bindHost: '193.168.10.144' }).urls(), { local: null, lanName: null, lan: ['http://193.168.10.144:4173/'] });
  assert.equal(policy({ getHostname: () => 'Other-Mac' }).urls().lanName, 'http://other-mac.local:4173/');
  assert.equal(policy({ getHostname: () => 'invalid/host' }).urls().lanName, null);
  assert.equal(policy({ getInterfaces: () => ({}) }).urls().lanName, null);
});

test('default port authority and invalid configuration are handled explicitly', () => {
  const network = policy({ port: 80 });
  assert.equal(network.allowsHost('localhost'), true);
  assert.equal(network.allowsHost('localhost:80'), true);
  assert.equal(network.allowsOrigin('http://localhost', 'localhost:80'), true);
  assert.equal(network.allowsOrigin('http://localhost:80', 'localhost'), false);
  assert.throws(() => policy({ port: 0 }), /PORT/);
  assert.throws(() => policy({ port: 65536 }), /PORT/);
});

test('HTTP mutation guard accepts same-origin LAN requests and rejects attacks before handler execution', async () => {
  const network = policy(); let mutations = 0;
  const server = createServer((req, res) => {
    const rejected = network.validateRequest(req);
    if (rejected) { res.writeHead(rejected.status).end(rejected.error); return; }
    if (req.method === 'POST') mutations += 1;
    res.writeHead(200).end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const send = headers => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await send({ Host: '193.168.10.144:4173', Origin: 'http://193.168.10.144:4173' }), 200);
    assert.equal(await send({ Host: '193.168.10.144:4173', Origin: 'http://localhost:4173' }), 403);
    assert.equal(await send({ Host: 'evil.test:4173', Origin: 'http://evil.test:4173' }), 403);
    assert.equal(mutations, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
