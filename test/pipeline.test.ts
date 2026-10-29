import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { approve, check, importReviewResult, protect, review, scan } from '../src/pipeline.js';
import { hashBytes, saveSource, writeManifest } from '../src/store.js';
import type { Artifact, Manifest } from '../src/types.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-pipeline-'));
  const stateDir = path.join(root, '.script-harbor');
  const site = path.join(root, 'dist');
  await mkdir(site);
  let script = 'window.harborFixture = true;';
  let providerCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/lib.js' || req.url === '/alias.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(script); return; }
    if (req.url === '/review') {
      providerCalls += 1;
      req.resume(); req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'low-risk', summary: 'No obvious high impact capability detected.', findings: [], relocation: { safe: true, reason: 'Classic standalone script.' } }) } }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '::', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/`;
  await writeFile(path.join(site, 'index.html'), '<!doctype html><script defer src="/lib.js"></script>');
  return {
    root, stateDir, site, origin,
    setScript(value: string) { script = value; },
    getProviderCalls() { return providerCalls; },
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); },
  };
}

test('scan, cached review, explicit approval, protect and check bind exact URL and bytes', async () => {
  const f = await fixture();
  try {
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const artifact = manifest.artifacts[0]!;
    assert.equal(artifact.sha256, hashBytes(Buffer.from('window.harborFixture = true;')).sha256);
    const options = { provider: 'openrouter' as const, model: 'fixture-model', stateDir: f.stateDir, apiKey: 'test-key', endpoint: `${f.origin}review` };
    const [first] = await review(options);
    assert.ok(first);
    await review(options);
    assert.equal(f.getProviderCalls(), 1, 'matching content/prompt/provider/model must use review cache');
    await approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'Inspected source and license.', allowRehost: true });
    await assert.rejects(check({ stateDir: f.stateDir, provider: 'claude', model: 'other-model' }), /No matching current review/);
    await protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true, provider: 'openrouter', model: 'fixture-model' });
    const html = await readFile(path.join(f.site, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`/vendor/script-harbor/${artifact.sha256}\\.js`));
    assert.match(html, /integrity="sha384-[^"]+"/);
    await check({ stateDir: f.stateDir, provider: 'openrouter', model: 'fixture-model' });
    await protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true, provider: 'openrouter', model: 'fixture-model' });
    assert.equal(await readFile(path.join(f.site, 'index.html'), 'utf8'), html, 'repeated protect is idempotent');
    await writeFile(path.join(f.site, 'vendor/script-harbor', `${artifact.sha256}.js`), 'tampered');
    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true, provider: 'openrouter', model: 'fixture-model' }), /size mismatch|hash\/SRI mismatch/);
  } finally { await f.close(); }
});

test('fresh changed upstream bytes fail before rewriting and persist a report', async () => {
  const f = await fixture();
  try {
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const artifact = manifest.artifacts[0]!;
    await importReviewResult({ stateDir: f.stateDir, hash: artifact.sha256, model: 'external-audit-1', result: { verdict: 'review-required', summary: 'Manual review completed.', findings: [], relocation: { safe: true, reason: 'Standalone classic script.' } } });
    await approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'Approved exact bytes for rehosting.', allowRehost: true });
    const before = await readFile(path.join(f.site, 'index.html'), 'utf8');
    f.setScript('window.harborFixture = false;');
    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true }), /Unknown or changed upstream script|No human approval/);
    assert.equal(await readFile(path.join(f.site, 'index.html'), 'utf8'), before);
    const report = await readFile(path.join(f.stateDir, 'report.md'), 'utf8');
    assert.match(report, /Unknown or changed upstream script/);
  } finally { await f.close(); }
});

test('external import rejects model supplied identity fields and validates strict result schema', async () => {
  const f = await fixture();
  try {
    f.setScript('window.ethereum.request({ method: "personal_sign" });');
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const hash = manifest.artifacts[0]!.sha256;
    const result = { verdict: 'review-required', summary: 'Reviewed.', findings: [], relocation: { safe: false, reason: 'Manual.' } };
    const imported = await importReviewResult({ stateDir: f.stateDir, hash, model: 'human-entered-model-label', result });
    assert.equal(imported.provider, 'external');
    assert.equal(imported.sha256, hash);
    const report = JSON.parse(await readFile(path.join(f.stateDir, 'report.json'), 'utf8')) as { artifacts: Array<{ staticHints: { classification: string; findings: Array<{ category: string }> } }> };
    assert.match(report.artifacts[0]!.staticHints.classification, /heuristic hints only/);
    assert.ok(report.artifacts[0]!.staticHints.findings.some((finding) => finding.category === 'wallet-signing'));
    assert.match(await readFile(path.join(f.stateDir, 'report.md'), 'utf8'), /Static capability hints/);
    assert.equal((await importReviewResult({ stateDir: f.stateDir, hash, model: 'human-entered-model-label', result })).fingerprint, imported.fingerprint);
    await assert.rejects(importReviewResult({ stateDir: f.stateDir, hash, model: 'human-entered-model-label', result: { ...result, summary: 'Changed after first import.' } }), /cannot be replaced/);
    await assert.rejects(importReviewResult({ stateDir: f.stateDir, hash, model: 'x', result: { ...result, sha256: 'f'.repeat(64) } }), /Unrecognized key/);
  } finally { await f.close(); }
});

test('approval and external review operations refuse a manifest with scan errors', async () => {
  const f = await fixture();
  try {
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const artifact = manifest.artifacts[0]!;
    await writeFile(path.join(f.stateDir, 'manifest.json'), `${JSON.stringify({ ...manifest, errors: ['prior partial capture'] })}\n`);
    await assert.rejects(approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'test' }), /scan errors/);
    await assert.rejects(importReviewResult({ stateDir: f.stateDir, hash: artifact.sha256, model: 'external', result: { verdict: 'low-risk', summary: '', findings: [], relocation: { safe: true, reason: '' } } }), /scan errors/);
    const pipeline = await import('../src/pipeline.js');
    await assert.rejects(pipeline.exportReviewInput({ stateDir: f.stateDir, hash: artifact.sha256 }), /scan errors/);
  } finally { await f.close(); }
});

test('scan persists its error manifest and both reports before returning failure', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.site, 'index.html'), '<script src="/absent.js"></script>');
    await assert.rejects(scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true }), /Scan completed with 1 error/);
    const manifest = JSON.parse(await readFile(path.join(f.stateDir, 'manifest.json'), 'utf8')) as { errors: string[] };
    assert.match(manifest.errors[0]!, /failed to capture/);
    assert.match(await readFile(path.join(f.stateDir, 'report.md'), 'utf8'), /failed to capture/);
    assert.match(await readFile(path.join(f.stateDir, 'report.json'), 'utf8'), /failed to capture/);
  } finally { await f.close(); }
});

test('approval for a hash at one URL does not authorize identical bytes at a new URL', async () => {
  const f = await fixture();
  try {
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const artifact = manifest.artifacts[0]!;
    await importReviewResult({ stateDir: f.stateDir, hash: artifact.sha256, model: 'external-audit', result: { verdict: 'low-risk', summary: 'Reviewed.', findings: [], relocation: { safe: true, reason: 'Standalone.' } } });
    await approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'Approved this URL.', allowRehost: true });
    await writeFile(path.join(f.site, 'index.html'), '<script src="/alias.js"></script>');
    const changedUrl = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    assert.equal(changedUrl.artifacts[0]!.sha256, artifact.sha256);
    assert.notEqual(changedUrl.artifacts[0]!.url, artifact.url);
    await assert.rejects(check({ stateDir: f.stateDir }), /No human approval for .*alias\.js/);
    const before = await readFile(path.join(f.site, 'index.html'), 'utf8');
    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true }), /Unknown or changed upstream script|No human approval/);
    assert.equal(await readFile(path.join(f.site, 'index.html'), 'utf8'), before);
  } finally { await f.close(); }
});

test('human approval cannot make high-risk or deterministic manual artifacts eligible for rehosting', async () => {
  const f = await fixture();
  try {
    f.setScript("import('./child.js');");
    const manifest = await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const artifact = manifest.artifacts[0]!;
    assert.equal(artifact.relocation, 'manual');
    await importReviewResult({ stateDir: f.stateDir, hash: artifact.sha256, model: 'external-audit', result: { verdict: 'high-risk', summary: 'High risk.', findings: [], relocation: { safe: true, reason: 'Model optimism is not sufficient.' } } });
    await approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'Acknowledged risk, no automatic relocation.', allowRehost: true });
    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true }), /High-risk review cannot be automatically rehosted/);
    await scan({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true });
    const optimisticReview = await importReviewResult({ stateDir: f.stateDir, hash: artifact.sha256, model: 'manual-check-model', result: { verdict: 'low-risk', summary: 'Model says okay.', findings: [], relocation: { safe: true, reason: 'Standalone according to model.' } } });
    await approve(artifact.sha256, { stateDir: f.stateDir, reviewer: 'Reviewer', reason: 'Testing deterministic blocker.', allowRehost: true, fingerprint: optimisticReview.fingerprint });
    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true, provider: 'external', model: 'manual-check-model' }), /Deterministic relocation blocker/);
    assert.match(await readFile(path.join(f.site, 'index.html'), 'utf8'), /\/lib.js/);
  } finally { await f.close(); }
});

test('protect fails closed for saved runtime-only third-party scripts and retains their evidence', async () => {
  const f = await fixture();
  try {
    const runtimeUrl = `http://localhost:${new URL(f.origin).port}/lib.js`;
    const html = `<script src="${runtimeUrl}"></script><script>setTimeout(() => { const runtimeScript = document.createElement("script"); runtimeScript.src = "${runtimeUrl}"; document.head.append(runtimeScript); }, 1000);</script>`;
    await writeFile(path.join(f.site, 'index.html'), html);
    const source = Buffer.from('window.harborFixture = true;');
    const hashes = await saveSource(f.stateDir, source);
    const artifact: Artifact = {
      url: runtimeUrl, finalUrl: runtimeUrl, ...hashes,
      bytes: source.byteLength, contentType: 'application/javascript', pages: [f.origin], kind: 'runtime',
      thirdParty: true, relocation: 'eligible', relocationReasons: [],
    };
    const saved: Manifest = {
      schemaVersion: 1, createdAt: new Date().toISOString(), origins: [f.origin], artifacts: [artifact], localScripts: [],
      coverage: { mode: 'runtime', pages: [f.origin], limitations: ['runtime observation is bounded'] }, errors: [],
    };
    await writeManifest(f.stateDir, saved);

    await assert.rejects(protect({ dir: f.site, origin: f.origin, stateDir: f.stateDir, allowLocal: true }), /Runtime-only third-party scripts require manual handling/);
    assert.equal(await readFile(path.join(f.site, 'index.html'), 'utf8'), html, 'the static reference and inline delayed loader remain unchanged');
    const failed = JSON.parse(await readFile(path.join(f.stateDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.ok(failed.artifacts.some((item) => item.url === artifact.url && item.kind === 'runtime'));
    assert.ok(failed.errors.some((message) => message.includes('Runtime-only third-party scripts')));
    await assert.rejects(check({ stateDir: f.stateDir }), /Manifest has capture errors/);
  } finally { await f.close(); }
});
