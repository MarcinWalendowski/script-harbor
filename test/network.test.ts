import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { fetchResource, isPublicAddress } from '../src/network.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('public address classifier excludes private, reserved, loopback, and mapped private IPv6', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('fetchResource resolves loopback through its pinned lookup only with explicit local opt-in', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end('const answer = 42;');
  });
  const base = await listen(server);
  try {
    await assert.rejects(fetchResource(`${base}/script.js`), /Blocked non-public address/);
    const result = await fetchResource(`${base}/script.js`, { allowLocal: true });
    assert.equal(result.url, `${base}/script.js`);
    assert.equal(result.finalUrl, result.url);
    assert.equal(result.contentType, 'application/javascript; charset=utf-8');
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'const answer = 42;');
  } finally { await close(server); }
});

test('redirects revalidate each target, retain the original URL, and enforce the redirect limit', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/final' }).end();
    } else if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' }).end();
    } else {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    }
  });
  const base = await listen(server);
  try {
    const result = await fetchResource(`${base}/start`, { allowLocal: true });
    assert.equal(result.url, `${base}/start`);
    assert.equal(result.finalUrl, `${base}/final`);
    assert.equal(result.body.toString(), '<html></html>');
    await assert.rejects(fetchResource(`${base}/start`, { allowLocal: true, maxRedirects: 0 }), /Too many redirects/);
    await assert.rejects(fetchResource(`${base}/loop`, { allowLocal: true, maxRedirects: 2 }), /Too many redirects/);
  } finally { await close(server); }
});

test('redirects reject unsupported protocols and credential-bearing destinations', async () => {
  const server = createServer((request, response) => {
    response.writeHead(302, { location: request.url === '/file' ? 'file:///etc/passwd' : 'http://user:pass@127.0.0.1/' }).end();
  });
  const base = await listen(server);
  try {
    await assert.rejects(fetchResource(`${base}/file`, { allowLocal: true }), /Unsupported URL protocol/);
    await assert.rejects(fetchResource(`${base}/credentials`, { allowLocal: true }), /credentials are not allowed/);
    await assert.rejects(fetchResource('http://user:pass@example.com/'), /credentials are not allowed/);
  } finally { await close(server); }
});

test('decompresses supported encodings and limits decoded response bytes', async () => {
  const plain = Buffer.from('compressed content '.repeat(100));
  const encodings = new Map([
    ['/gzip', ['gzip', gzipSync(plain)] as const],
    ['/deflate', ['deflate', deflateSync(plain)] as const],
    ['/br', ['br', brotliCompressSync(plain)] as const],
  ]);
  const server = createServer((request, response) => {
    const [encoding, bytes] = encodings.get(request.url ?? '') ?? ['identity', plain];
    response.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': encoding });
    response.end(bytes);
  });
  const base = await listen(server);
  try {
    for (const endpoint of ['/gzip', '/deflate', '/br']) {
      const result = await fetchResource(`${base}${endpoint}`, { allowLocal: true, maxBytes: plain.length });
      assert.deepEqual(result.body, plain);
      await assert.rejects(fetchResource(`${base}${endpoint}`, { allowLocal: true, maxBytes: plain.length - 1 }), /decoded bytes/);
    }
  } finally { await close(server); }
});

test('unsupported encodings, non-success status and request deadlines fail closed', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/slow') {
      response.writeHead(200).flushHeaders();
      setTimeout(() => response.end('late'), 100);
    } else if (request.url === '/encoding') {
      response.writeHead(200, { 'content-encoding': 'compress' }).end('body');
    } else response.writeHead(404).end('missing');
  });
  const base = await listen(server);
  try {
    await assert.rejects(fetchResource(`${base}/missing`, { allowLocal: true }), /HTTP 404/);
    await assert.rejects(fetchResource(`${base}/encoding`, { allowLocal: true }), /Unsupported content encoding/);
    await assert.rejects(fetchResource(`${base}/slow`, { allowLocal: true, timeoutMs: 20 }), /deadline|timed out/i);
  } finally { await close(server); }
});

test('truncated compressed streams reject without waiting for the deadline', { timeout: 2000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': '1000' });
    response.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    setTimeout(() => response.destroy(), 20);
  });
  const base = await listen(server);
  try {
    await assert.rejects(fetchResource(base, { allowLocal: true, timeoutMs: 300 }), /aborted|deadline|reset/i);
  } finally { await close(server); }
});
