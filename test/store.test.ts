import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hashBytes, readAllReviews, readApprovals, readManifest, readReview, readSource, reviewFingerprint, saveSource, validateReviewResult, writeApprovals, writeManifest, writeReview } from '../src/store.js';
import type { Approval, Manifest, Review } from '../src/types.js';

async function tempState(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'script-harbor-store-'));
}

function sampleManifest(): Manifest {
  return {
    schemaVersion: 1, createdAt: new Date().toISOString(), origins: ['https://site.example/'],
    artifacts: [], localScripts: [],
    coverage: { mode: 'static', pages: ['https://site.example/'], limitations: [] }, errors: [],
  };
}

function sampleReview(sourceHash: string): Review {
  const fingerprint = reviewFingerprint(sourceHash, 'external', 'model-x');
  return {
    schemaVersion: 1, fingerprint, sha256: sourceHash, provider: 'external', model: 'model-x',
    promptVersion: '1', policyVersion: '1', createdAt: new Date().toISOString(),
    verdict: 'review-required', summary: 'Needs human review', findings: [], relocation: { safe: false, reason: 'Unknown' },
  };
}

test('hashes, persists, and verifies exact source bytes', async () => {
  const dir = await tempState();
  try {
    const body = Buffer.from('export const safe = true;');
    const expected = hashBytes(body);
    assert.deepEqual(await saveSource(dir, body), expected);
    assert.deepEqual(await readSource(dir, expected.sha256), body);
    await writeFile(path.join(dir, 'sources', `${expected.sha256}.js`), 'changed');
    await assert.rejects(readSource(dir, expected.sha256), /integrity check failed/);
    await assert.rejects(readSource(dir, '../manifest'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manifest schema rejects unknown keys, invalid versions, timestamps and hashes', async () => {
  const dir = await tempState();
  try {
    const manifest = sampleManifest();
    await writeManifest(dir, manifest);
    assert.deepEqual(await readManifest(dir), manifest);
    const file = path.join(dir, 'manifest.json');
    await writeFile(file, JSON.stringify({ ...manifest, extra: true }));
    await assert.rejects(readManifest(dir));
    await writeFile(file, JSON.stringify({ ...manifest, schemaVersion: 2 }));
    await assert.rejects(readManifest(dir));
    await writeFile(file, JSON.stringify({ ...manifest, createdAt: 'yesterday' }));
    await assert.rejects(readManifest(dir));
    await writeFile(file, JSON.stringify({ ...manifest, artifacts: [{
      url: 'https://cdn.example/a.js', finalUrl: 'https://cdn.example/a.js', sha256: 'bad', sri: 'sha384-a',
      bytes: 1, contentType: 'application/javascript', pages: [], kind: 'classic', thirdParty: true,
      relocation: 'eligible', relocationReasons: [],
    }] }));
    await assert.rejects(readManifest(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reviews validate every persisted field and their content fingerprint', async () => {
  const dir = await tempState();
  try {
    const { sha256 } = hashBytes(Buffer.from('x'));
    const review = sampleReview(sha256);
    await writeReview(dir, review);
    assert.deepEqual(await readReview(dir, review.fingerprint), review);
    const file = path.join(dir, 'reviews', `${review.fingerprint}.json`);
    await writeFile(file, JSON.stringify({ ...review, model: 'tampered' }));
    await assert.rejects(readReview(dir, review.fingerprint), /fingerprint does not match/);
    await assert.rejects(readReview(dir, '../manifest'));
    await assert.rejects(writeReview(dir, { ...review, extra: true } as Review));
    assert.deepEqual(validateReviewResult({ verdict: 'low-risk', summary: '', findings: [], relocation: { safe: true, reason: '' } }).findings, []);
    assert.throws(() => validateReviewResult({ verdict: 'approved', summary: '', findings: [], relocation: { safe: true, reason: '' } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('review enumeration ignores malformed, symlinked, and non-json entries', async () => {
  const dir = await tempState();
  try {
    const { sha256 } = hashBytes(Buffer.from('x'));
    const review = sampleReview(sha256);
    await writeReview(dir, review);
    await writeFile(path.join(dir, 'reviews', `${'a'.repeat(64)}.json`), '{');
    await writeFile(path.join(dir, 'reviews', 'notes.txt'), JSON.stringify(review));
    await symlink(path.join(dir, 'reviews', `${review.fingerprint}.json`), path.join(dir, 'reviews', `${'b'.repeat(64)}.json`));
    assert.deepEqual(await readAllReviews(dir), [review]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approval schema is strict and absent approvals default to an empty list', async () => {
  const dir = await tempState();
  try {
    assert.deepEqual(await readApprovals(dir), []);
    const { sha256 } = hashBytes(Buffer.from('x'));
    const approval: Approval = {
      sha256, fingerprint: reviewFingerprint(sha256, 'external', 'model-x'), reviewer: 'Alex', reason: 'Reviewed',
      approvedAt: new Date().toISOString(), allowRehost: true, urls: ['https://example.com/lib.js'],
    };
    await writeApprovals(dir, [approval]);
    assert.deepEqual(await readApprovals(dir), [approval]);
    await writeFile(path.join(dir, 'approvals.json'), JSON.stringify([{ ...approval, allowRehost: 'yes' }]));
    await assert.rejects(readApprovals(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source and state reads reject symlinked paths', async () => {
  const dir = await tempState();
  const outside = await tempState();
  try {
    const { sha256 } = hashBytes(Buffer.from('safe'));
    await mkdir(path.join(dir, 'sources'));
    await writeFile(path.join(outside, 'target.js'), 'safe');
    await symlink(path.join(outside, 'target.js'), path.join(dir, 'sources', `${sha256}.js`));
    await assert.rejects(readSource(dir, sha256), /symlink/);
    await mkdir(path.join(outside, 'reviews'));
    await writeFile(path.join(outside, 'reviews', 'anything'), '');
    await rm(path.join(dir, 'reviews'), { recursive: true, force: true });
    await symlink(path.join(outside, 'reviews'), path.join(dir, 'reviews'));
    await assert.rejects(readAllReviews(dir), /symlink/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
