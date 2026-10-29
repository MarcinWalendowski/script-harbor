import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discover, parseReferences, relocationReasons } from '../src/discovery.js';
import { readManifest, writeManifest } from '../src/store.js';

test('parses scripts and modulepreload with entity, base and protocol-relative URLs', () => {
  const html = '<base href="/assets/"><script src="a&amp;b.js"></script><script type="module" src="//cdn.example/m.js"></script><link rel="modulepreload" href="dep.js">';
  const refs = parseReferences(html, 'https://site.example/path/index.html');
  assert.deepEqual(refs.map(r => [r.url, r.kind]), [
    ['https://site.example/assets/a&b.js', 'classic'],
    ['https://cdn.example/m.js', 'module'],
    ['https://site.example/assets/dep.js', 'preload'],
  ]);
});

test('rejects cross-origin bases and duplicate attributes', () => {
  assert.throws(() => parseReferences('<base href="https://other.example/"><script src="x.js"></script>', 'https://site.example/'), /cross-origin base/);
  assert.throws(() => parseReferences('<script src="a.js" src="b.js"></script>', 'https://site.example/'), /duplicate HTML attribute/);
});

test('captures exact decompressed bytes and fails closed on page/script errors', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-discovery-'));
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<script src="/app.js"></script><script type="module" src="/module.js"></script>'); return; }
    if (req.url === '/latin.js') { res.setHeader('content-type', 'application/javascript; charset=iso-8859-1'); res.end('window.café=1'); return; }
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end('window.app = "ok";'); return; }
    if (req.url === '/module.js') { res.setHeader('content-type', 'text/javascript'); res.end('import "./dep.js";'); return; }
    res.statusCode = 404; res.end('missing');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const manifest = await discover({ urls: [url], stateDir: state, allowLocal: true });
    assert.equal(manifest.artifacts.length, 2);
    assert.equal(manifest.artifacts[0]?.bytes, Buffer.byteLength('window.app = "ok";'));
    assert.equal(manifest.artifacts.find(a => a.kind === 'module')?.relocation, 'manual');
    assert.equal(manifest.errors.length, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('marks possible remote loaders for manual relocation', () => {
  assert.match(relocationReasons('fetch("https://cdn.example/x.js")', 'classic').join(' '), /possible remote/);
  assert.match(relocationReasons('const s=document.createElement("script"); s.src="./next.js"', 'classic').join(' '), /dynamic script creation/);
  assert.match(relocationReasons('new Worker(new URL("./worker.js", import.meta.url))', 'classic').join(' '), /worker/i);
  assert.match(relocationReasons('const u = document.currentScript.src', 'classic').join(' '), /source-relative/);
  assert.ok(relocationReasons('const x = 1', 'classic').length === 0);
});

test('rejects empty scans, invalid origins, non-HTML pages, and marks local access', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-empty-'));
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/javascript'); res.end('window.x=1'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const invalid = await discover({ urls: [`ftp://127.0.0.1:${address.port}/`], stateDir: state });
    assert.match(invalid.errors.join(' '), /HTTP\(S\)/);
    const wrongMime = await discover({ urls: [`http://127.0.0.1:${address.port}/`], stateDir: state, allowLocal: true });
    assert.match(wrongMime.errors.join(' '), /unexpected page MIME/);
    assert.match(wrongMime.coverage.limitations.join(' '), /LOCAL NETWORK ACCESS IS ENABLED/);
    const charset = await discover({ urls: [`http://127.0.0.1:${address.port}/`], stateDir: state, allowLocal: true });
    assert.equal(charset.errors.some(e => /unsupported script charset/.test(e)), false);
    const latinPage = createServer((req, res) => {
      if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<script src="/latin.js"></script>'); }
      else { res.setHeader('content-type', 'application/javascript; charset=iso-8859-1'); res.end('window.café=1'); }
    });
    await new Promise<void>(resolve => latinPage.listen(0, '127.0.0.1', resolve));
    const latinAddress = latinPage.address();
    assert(latinAddress && typeof latinAddress !== 'string');
    try {
      const latin = await discover({ urls: [`http://127.0.0.1:${latinAddress.port}/`], stateDir: state, allowLocal: true });
      assert.match(latin.errors.join(' '), /unsupported script charset: iso-8859-1/);
    } finally { await new Promise<void>(resolve => latinPage.close(() => resolve())); }
    const empty = await discover({ stateDir: state });
    assert.match(empty.errors.join(' '), /requires at least one/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('rejects symlink scan roots without reading through them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-symlink-'));
  const pages = path.join(root, 'pages');
  const link = path.join(root, 'link');
  await mkdir(pages);
  await writeFile(path.join(pages, 'index.html'), '<script src="https://cdn.example/a.js"></script>');
  await symlink(pages, link);
  try {
    const manifest = await discover({ dir: link, origin: 'https://site.example/', stateDir: path.join(root, 'state') });
    assert.match(manifest.errors.join(' '), /scan directory is a symlink/);
    assert.equal(manifest.coverage.pages.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails the scan if repeated captures of one URL produce different bytes', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-conflict-'));
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<script src="/changing.js"></script><script src="/changing.js"></script>'); return; }
    res.setHeader('content-type', 'text/javascript'); res.end(++calls === 1 ? 'window.v=1' : 'window.v=2');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const manifest = await discover({ urls: [`http://127.0.0.1:${address.port}/`], stateDir: state, allowLocal: true });
    assert.match(manifest.errors.join(' '), /conflicting bytes captured/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('keeps the default script ceiling at 100 and accepts a larger bounded override', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-script-budget-'));
  let requests = 0;
  const tags = Array.from({ length: 101 }, () => '<script src="/same.js"></script>').join('');
  const server = createServer((req, res) => {
    requests += 1;
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(tags); return; }
    res.setHeader('content-type', 'text/javascript'); res.end('window.stable=1');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    const defaults = await discover({ urls: [url], stateDir: path.join(state, 'default'), allowLocal: true });
    assert.match(defaults.errors.join(' '), /script limit exceeded: found 101, limit 100/);
    requests = 0;
    const expanded = await discover({ urls: [url], stateDir: path.join(state, 'expanded'), allowLocal: true, maxScripts: 101 });
    assert.deepEqual(expanded.errors, []);
    assert.equal(requests, 102);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('runtime request budget defaults to 200 and accepts a larger bounded override', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-request-budget-'));
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<script>for(let i=0;i<205;i++) fetch("/resource?i="+i).catch(()=>{});</script>');
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    const defaults = await discover({ urls: [url], stateDir: path.join(state, 'default'), allowLocal: true, runtime: true, observeMs: 1000 });
    assert.match(defaults.errors.join(' '), /runtime request limit exceeded \(200\)/);
    const expanded = await discover({ urls: [url], stateDir: path.join(state, 'expanded'), allowLocal: true, runtime: true, observeMs: 1000, maxRequests: 300 });
    assert.equal(expanded.errors.some(error => /runtime request limit exceeded/.test(error)), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('attributes iframe runtime scripts to the audited top-level page and persists valid manifest data', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-runtime-frame-owner-'));
  const scriptServer = createServer((_req, res) => { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end('window.frameLibrary = true;'); });
  await new Promise<void>(resolve => scriptServer.listen(0, '127.0.0.1', resolve));
  const scriptAddress = scriptServer.address();
  assert(scriptAddress && typeof scriptAddress !== 'string');
  const scriptUrl = `http://127.0.0.1:${scriptAddress.port}/frame.js`;
  const pageServer = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<iframe srcdoc="&lt;script src='${scriptUrl}'&gt;&lt;/script&gt;"></iframe>`);
  });
  await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const pageAddress = pageServer.address();
  assert(pageAddress && typeof pageAddress !== 'string');
  const pageUrl = `http://127.0.0.1:${pageAddress.port}/`;
  try {
    const manifest = await discover({ urls: [pageUrl], stateDir: state, allowLocal: true, runtime: true, observeMs: 500 });
    await writeManifest(state, manifest);
    const persisted = await readManifest(state);
    const captured = persisted.artifacts.find(artifact => artifact.url === scriptUrl);
    assert.ok(captured);
    assert.equal(captured.kind, 'runtime');
    assert.deepEqual(captured.pages, [pageUrl]);
    assert.equal(captured.thirdParty, true);
    assert.deepEqual(persisted.errors, []);
  } finally {
    await new Promise<void>(resolve => pageServer.close(() => resolve()));
    await new Promise<void>(resolve => scriptServer.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('rejects out-of-range scan limits before making requests or launching runtime capture', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'harbor-invalid-budget-'));
  let requests = 0;
  const server = createServer((_req, res) => { requests += 1; res.setHeader('content-type', 'text/html'); res.end('<p>ok</p>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    await assert.rejects(discover({ urls: [url], stateDir: state, allowLocal: true, maxScripts: 1001 }), /maxScripts must be an integer from 1 through 1000/);
    await assert.rejects(discover({ urls: [url], stateDir: state, allowLocal: true, runtime: true, maxRequests: 2001 }), /maxRequests must be an integer from 1 through 2000/);
    await assert.rejects(discover({ urls: [url], stateDir: state, maxScripts: 0 }), /maxScripts must be an integer from 1 through 1000/);
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});
