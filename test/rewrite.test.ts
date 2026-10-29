import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashBytes, saveSource } from '../src/store.js';
import { protectDirectory, rewriteHtml, vendorArtifacts } from '../src/rewrite.js';
import type { Artifact } from '../src/types.js';

function artifact(url: string, source: string, thirdParty = true): Artifact {
  const hashes = hashBytes(Buffer.from(source));
  return { url, finalUrl: url, ...hashes, bytes: Buffer.byteLength(source), contentType: 'text/javascript', pages: ['https://site.example/'], kind: 'classic', thirdParty, relocation: 'eligible', relocationReasons: [] };
}

test('rewrites only script URL and refreshes existing SRI while preserving attributes', () => {
  const input = '<html><script async defer nonce="n" integrity="sha384-old" crossorigin="use-credentials" src="https://cdn.example/lib.js"></script><p>keep</p></html>';
  const a = artifact('https://cdn.example/lib.js', 'window.lib = true;');
  const output = rewriteHtml(input, 'https://site.example/', [a], 'vendor/harbor');
  assert.match(output, /async defer nonce="n" integrity="sha384-[^"]+" crossorigin="anonymous" src="\/vendor\/harbor\/[a-f0-9]{64}\.js"/);
  assert.match(output, /<p>keep<\/p>/);
  assert.equal(rewriteHtml(output, 'https://site.example/', [a], 'vendor/harbor'), output);
});

test('adds SRI to new tags and preserves module type and unrelated formatting', () => {
  const input = '<script type=module src=https://cdn.example/app.js></script>\n';
  const a = { ...artifact('https://cdn.example/app.js', 'export const x=1'), kind: 'module' as const };
  const output = rewriteHtml(input, 'https://site.example/', [a], 'v');
  assert.match(output, /type=module src=\/v\/[a-f0-9]{64}\.js integrity="sha384-[^"]+" crossorigin="anonymous"/);
  assert.ok(output.endsWith('\n'));
});

test('rewrites boolean crossorigin and integrity attributes safely', () => {
  const input = '<script crossorigin integrity src="https://cdn.example/lib.js"></script>';
  const a = artifact('https://cdn.example/lib.js', 'window.lib=true;');
  const output = rewriteHtml(input, 'https://site.example/', [a], 'vendor/harbor');
  assert.match(output, /crossorigin="anonymous" integrity="sha384-[^"]+" src="\/vendor\/harbor\/[a-f0-9]{64}\.js"/);
  assert.throws(() => rewriteHtml(input, 'https://site.example/', [a], '../escape'), /unsafe public path/);
  assert.throws(() => rewriteHtml(input, 'https://site.example/', [a], '/absolute'), /unsafe public path/);
});

test('vendors exact source bytes and protect validates all pages before mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-rewrite-'));
  const state = path.join(root, 'state');
  const site = path.join(root, 'site');
  const a = artifact('https://cdn.example/lib.js', 'window.lib = 42;');
  try {
    await mkdir(site);
    await writeFile(path.join(site, 'index.html'), '<script src="https://cdn.example/lib.js"></script>');
    await writeFile(path.join(site, 'bad.html'), '<script src="one.js" src="two.js"></script>');
    await saveSource(state, Buffer.from('window.lib = 42;'));
    await assert.rejects(protectDirectory(site, 'https://site.example/', state, [a]), /duplicate HTML attribute/);
    assert.equal(await readFile(path.join(site, 'index.html'), 'utf8'), '<script src="https://cdn.example/lib.js"></script>');
    await rm(path.join(site, 'bad.html'));
    const mapping = await vendorArtifacts(state, [a], site, 'vendor/harbor');
    assert.equal(mapping[a.url], `/vendor/harbor/${a.sha256}.js`);
    assert.deepEqual(await readFile(path.join(site, 'vendor/harbor', `${a.sha256}.js`)), Buffer.from('window.lib = 42;'));
    await protectDirectory(site, 'https://site.example/', state, [a]);
    const protectedHtml = await readFile(path.join(site, 'index.html'), 'utf8');
    assert.match(protectedHtml, new RegExp(`/vendor/script-harbor/${a.sha256}\\.js`));
    assert.equal(await protectDirectory(site, 'https://site.example/', state, [a]).then(() => readFile(path.join(site, 'index.html'), 'utf8')), protectedHtml);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standalone vendor validates sources and paths before creating output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-vendor-safe-'));
  const state = path.join(root, 'state');
  const publicDir = path.join(root, 'public');
  const a = artifact('https://cdn.example/lib.js', 'window.lib=1');
  const missing = { ...artifact('https://cdn.example/missing.js', 'nope'), sha256: 'a'.repeat(64) };
  try {
    await saveSource(state, Buffer.from('window.lib=1'));
    await assert.rejects(vendorArtifacts(state, [a, missing], publicDir), /Source not found/);
    await assert.rejects(lstat(publicDir), { code: 'ENOENT' });
    await assert.rejects(vendorArtifacts(state, [a], publicDir, '../escape'), /unsafe public path/);
    await assert.rejects(vendorArtifacts(state, [a], publicDir, '/absolute'), /unsafe public path/);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await mkdir(publicDir);
    await symlink(outside, path.join(publicDir, 'vendor'));
    await assert.rejects(vendorArtifacts(state, [a], publicDir), /symlink destination/);
    await assert.rejects(lstat(path.join(outside, 'script-harbor')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
