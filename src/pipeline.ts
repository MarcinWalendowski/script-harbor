import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt } from './analysis.js';
import { discover } from './discovery.js';
import { fetchResource } from './network.js';
import { protectDirectory, vendorArtifacts } from './rewrite.js';
import { appendEvent, hashBytes, readAllReviews, readApprovals, readManifest, readReview, readSource, reviewFingerprint, validateReviewResult, writeApprovals, writeManifest, writeReview } from './store.js';
import { requestReview } from './providers.js';
import { writeReport } from './report.js';
import { POLICY_VERSION, PROMPT_VERSION } from './types.js';
import type { Approval, Artifact, Manifest, Provider, ProtectOptions, Review, ReviewOptions, ScanOptions } from './types.js';

const DEFAULT_STATE = '.script-harbor';
const stateOf = (stateDir?: string): string => stateDir ?? DEFAULT_STATE;

function strictUtf8(body: Buffer, artifact: Artifact): string {
  if (body.byteLength !== artifact.bytes) throw new Error(`source size mismatch for ${artifact.url}`);
  const hashes = hashBytes(body);
  if (hashes.sha256 !== artifact.sha256 || hashes.sri !== artifact.sri) throw new Error(`source hash/SRI mismatch for ${artifact.url}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new Error(`source is not valid UTF-8: ${artifact.url}`); }
}

async function persistScan(stateDir: string, manifest: Manifest, failOnErrors: boolean): Promise<Manifest> {
  await writeManifest(stateDir, manifest);
  await writeReport(stateDir, manifest);
  await appendEvent(stateDir, { type: 'scan', at: new Date().toISOString(), artifacts: manifest.artifacts.length, errors: manifest.errors.length });
  if (failOnErrors && manifest.errors.length) throw new Error(`Scan completed with ${manifest.errors.length} error(s); see ${path.join(stateDir, 'report.md')}`);
  return manifest;
}

export async function scan(options: ScanOptions): Promise<Manifest> {
  const stateDir = stateOf(options.stateDir);
  const manifest = await discover({ ...options, stateDir });
  return await persistScan(stateDir, manifest, true);
}

export async function review(options: ReviewOptions): Promise<Review[]> {
  if (options.provider === 'external') throw new Error('Use import-review for externally generated reviews');
  if (!options.model?.trim()) throw new Error('A provider model is required');
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error('Cannot review a manifest containing scan errors');
  const results: Review[] = [];
  for (const artifact of manifest.artifacts) {
    const source = strictUtf8(await readSource(stateDir, artifact.sha256), artifact);
    const fingerprint = reviewFingerprint(artifact.sha256, options.provider, options.model, PROMPT_VERSION, POLICY_VERSION);
    const cached = await readReview(stateDir, fingerprint);
    if (cached) { results.push(cached); continue; }
    const result = await requestReview(source, options);
    const item: Review = { ...result, schemaVersion: 1, fingerprint, sha256: artifact.sha256, provider: options.provider, model: options.model, promptVersion: PROMPT_VERSION, policyVersion: POLICY_VERSION, createdAt: new Date().toISOString() };
    await writeReview(stateDir, item);
    await appendEvent(stateDir, { type: 'review', at: item.createdAt, sha256: item.sha256, fingerprint, provider: item.provider, model: item.model });
    results.push(item);
  }
  await writeReport(stateDir, manifest);
  return results;
}

export async function approve(hash: string, options: { stateDir?: string; reviewer: string; reason: string; allowRehost?: boolean; fingerprint?: string }): Promise<Approval> {
  if (!options.reviewer.trim() || !options.reason.trim()) throw new Error('Reviewer and reason are required');
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error('Cannot approve a manifest containing scan errors');
  const artifact = manifest.artifacts.find((item) => item.sha256 === hash);
  if (!artifact) throw new Error(`Hash is not present in the current manifest: ${hash}`);
  strictUtf8(await readSource(stateDir, hash), artifact);
  const candidates = (await readAllReviews(stateDir)).filter((item) => item.sha256 === hash && item.promptVersion === PROMPT_VERSION && item.policyVersion === POLICY_VERSION);
  if (options.fingerprint && !candidates.some((item) => item.fingerprint === options.fingerprint)) throw new Error('Selected review fingerprint is not a current review for this hash');
  if (!options.fingerprint && candidates.length !== 1) throw new Error(candidates.length ? 'Multiple current reviews exist; select --fingerprint explicitly' : 'No current review exists for this hash');
  const selected = candidates.find((item) => item.fingerprint === options.fingerprint) ?? candidates[0]!;
  const approval: Approval = { sha256: hash, fingerprint: selected.fingerprint, urls: [...new Set(manifest.artifacts.filter((item) => item.sha256 === hash).map((item) => item.url))], reviewer: options.reviewer.trim(), reason: options.reason.trim(), approvedAt: new Date().toISOString(), allowRehost: options.allowRehost === true };
  const approvals = await readApprovals(stateDir);
  await writeApprovals(stateDir, [...approvals.filter((item) => !(item.sha256 === hash && item.fingerprint === selected.fingerprint)), approval]);
  await appendEvent(stateDir, { type: 'approval', at: approval.approvedAt, sha256: hash, fingerprint: selected.fingerprint, url: artifact.url, reviewer: approval.reviewer, allowRehost: approval.allowRehost });
  await writeReport(stateDir, manifest);
  return approval;
}

async function currentReview(artifact: Artifact, stateDir: string, provider?: Provider, model?: string): Promise<Review> {
  if ((provider && !model) || (!provider && model)) throw new Error('Provider and model must be selected together');
  const reviews = (await readAllReviews(stateDir)).filter((item) => item.sha256 === artifact.sha256 && item.promptVersion === PROMPT_VERSION && item.policyVersion === POLICY_VERSION);
  const selected = provider ? reviews.filter((item) => item.provider === provider && item.model === model) : reviews;
  if (selected.length !== 1) throw new Error(selected.length ? `Ambiguous reviews for ${artifact.url}; select --provider and --model` : `No matching current review for ${artifact.url}`);
  return selected[0]!;
}

async function validateArtifact(artifact: Artifact, stateDir: string, provider?: Provider, model?: string, requireRehost = true): Promise<void> {
  strictUtf8(await readSource(stateDir, artifact.sha256), artifact);
  const selected = await currentReview(artifact, stateDir, provider, model);
  const approval = (await readApprovals(stateDir)).find((item) => item.sha256 === artifact.sha256 && item.fingerprint === selected.fingerprint && item.urls.includes(artifact.url));
  if (!approval) throw new Error(`No human approval for ${artifact.url} review ${selected.fingerprint}`);
  if (requireRehost && !approval.allowRehost) throw new Error(`Approval does not permit rehosting ${artifact.url}`);
  if (selected.verdict === 'high-risk') throw new Error(`High-risk review cannot be automatically rehosted: ${artifact.url}`);
  if (!selected.relocation.safe) throw new Error(`Review marked relocation unsafe: ${artifact.url}`);
  if (artifact.relocation !== 'eligible' || artifact.relocationReasons.length) throw new Error(`Deterministic relocation blocker: ${artifact.url}: ${artifact.relocationReasons.join('; ')}`);
}

export async function check(options: { stateDir?: string; provider?: Provider; model?: string; live?: boolean; allowLocal?: boolean } = {}): Promise<void> {
  if ((options.provider && !options.model) || (!options.provider && options.model)) throw new Error('Provider and model must be selected together');
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error(`Manifest has capture errors: ${manifest.errors.join('; ')}`);
  for (const artifact of manifest.artifacts) {
    await validateArtifact(artifact, stateDir, options.provider, options.model, false);
    if (options.live) {
      const response = await fetchResource(artifact.url, { allowLocal: options.allowLocal });
      if (hashBytes(response.body).sha256 !== artifact.sha256) throw new Error(`Upstream drift detected for ${artifact.url}`);
    }
  }
  await appendEvent(stateDir, { type: 'check', at: new Date().toISOString(), live: options.live === true, artifacts: manifest.artifacts.length });
}

export async function vendor(options: { stateDir?: string; publicDir: string; publicPath?: string }): Promise<Record<string, string>> {
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error('Cannot vendor a manifest containing scan errors');
  for (const artifact of manifest.artifacts) await validateArtifact(artifact, stateDir);
  return await vendorArtifacts(stateDir, manifest.artifacts, options.publicDir, options.publicPath);
}

async function checkExistingVendorRefs(dir: string, manifest: Manifest, stateDir: string, publicPath = 'vendor/script-harbor', provider?: Provider, model?: string): Promise<void> {
  const prefix = `/${publicPath.replace(/^\/+|\/+$/g, '')}/`;
  for (const url of manifest.localScripts) {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(prefix)) continue;
    const fileName = parsed.pathname.slice(prefix.length);
    const match = fileName.match(/^([a-f0-9]{64})\.js$/);
    if (!match) throw new Error(`Unrecognized local Script Harbor vendor reference: ${url}`);
    const artifacts = manifest.artifacts.filter((item) => item.sha256 === match[1]);
    if (!artifacts.length) throw new Error(`Unrecognized local Script Harbor vendor reference: ${url}`);
    for (const artifact of artifacts) await validateArtifact(artifact, stateDir, provider, model);
    const artifact = artifacts[0]!;
    const file = path.resolve(dir, `.${parsed.pathname}`);
    const body = await readFile(file).catch(() => { throw new Error(`Missing local vendor bytes: ${file}`); });
    strictUtf8(body, artifact);
  }
}

export async function protect(options: ProtectOptions): Promise<Manifest> {
  const stateDir = stateOf(options.stateDir);
  let saved: Manifest;
  try { saved = await readManifest(stateDir); }
  catch { throw new Error('protect requires a previously reviewed and approved manifest'); }
  if (saved.errors.length) throw new Error('protect requires a saved manifest without scan errors');
  const fresh = await discover({ ...options, stateDir });
  try {
    if (fresh.errors.length) throw new Error(`Fresh scan has errors: ${fresh.errors.join('; ')}`);
    const runtimeOnly = saved.artifacts.filter((artifact) => artifact.kind === 'runtime' && artifact.thirdParty && !saved.artifacts.some((prior) => prior.url === artifact.url && prior.kind !== 'runtime'));
    if (runtimeOnly.length) throw new Error(`Runtime-only third-party scripts require manual handling; a fresh static reference cannot prove all runtime loads were rewritten: ${runtimeOnly.map((artifact) => artifact.url).join(', ')}`);
    const savedByUrl = new Map(saved.artifacts.map((item) => [item.url, item]));
    const approvals = await readApprovals(stateDir);
    for (const artifact of fresh.artifacts) {
      const authorized = savedByUrl.get(artifact.url);
      if (!authorized || authorized.sha256 !== artifact.sha256) throw new Error(`Unknown or changed upstream script; review and approve before protect: ${artifact.url}`);
      const selected = await currentReview(authorized, stateDir, options.provider, options.model);
      if (!approvals.some((item) => item.sha256 === authorized.sha256 && item.fingerprint === selected.fingerprint)) throw new Error(`No approval for fresh upstream script ${artifact.url}`);
      await validateArtifact(artifact, stateDir, options.provider, options.model);
    }
    // A repeated protect sees local references. Resolve them only through the previously saved URL/hash authorization.
    const vendorPrefix = `/${(options.publicPath ?? 'vendor/script-harbor').replace(/^\/+|\/+$/g, '')}/`;
    const locallyReferencedHashes = new Set(fresh.localScripts.flatMap((url) => {
      const pathname = new URL(url).pathname;
      if (!pathname.startsWith(vendorPrefix)) return [];
      const match = pathname.slice(vendorPrefix.length).match(/^([a-f0-9]{64})\.js$/);
      return match ? [match[1]!] : [];
    }));
    const activeSaved = saved.artifacts.filter((item) => locallyReferencedHashes.has(item.sha256));
    const activeKeys = new Set<string>();
    const activeArtifacts = [...activeSaved, ...fresh.artifacts].filter((item) => {
      const key = `${item.url}\0${item.kind}`;
      if (activeKeys.has(key)) return false;
      activeKeys.add(key);
      return true;
    });
    const authorizedManifest = { ...fresh, artifacts: activeArtifacts };
    if (fresh.localScripts.length) await checkExistingVendorRefs(options.dir!, authorizedManifest, stateDir, options.publicPath, options.provider, options.model);
    await protectDirectory(options.dir!, options.origin!, stateDir, fresh.artifacts, options.publicPath);
    const result = authorizedManifest;
    await writeManifest(stateDir, result);
    await writeReport(stateDir, result);
    await appendEvent(stateDir, { type: 'protect', at: new Date().toISOString(), artifacts: result.artifacts.length });
    return result;
  } catch (error) {
    fresh.errors.push(error instanceof Error ? error.message : String(error));
    const runtimeEvidence = saved.artifacts.filter((artifact) => artifact.kind === 'runtime' && artifact.thirdParty && !saved.artifacts.some((prior) => prior.url === artifact.url && prior.kind !== 'runtime'));
    const retained = new Map([...fresh.artifacts, ...runtimeEvidence].map((artifact) => [`${artifact.url}\0${artifact.kind}`, artifact]));
    const failedManifest = { ...fresh, artifacts: [...retained.values()] };
    await writeManifest(stateDir, failedManifest);
    await writeReport(stateDir, failedManifest);
    throw error;
  }
}

export async function exportReviewInput(options: { stateDir?: string; hash: string; maxChars?: number }): Promise<{ sha256: string; promptVersion: string; policyVersion: string; schema: string; system: string; user: string }> {
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error('Cannot export a review from a manifest containing scan errors');
  const artifact = manifest.artifacts.find((item) => item.sha256 === options.hash);
  if (!artifact) throw new Error(`Hash is not present in current manifest: ${options.hash}`);
  const source = strictUtf8(await readSource(stateDir, artifact.sha256), artifact);
  const prompt = buildPrompt(source, options.maxChars);
  return { sha256: artifact.sha256, promptVersion: PROMPT_VERSION, policyVersion: POLICY_VERSION, schema: '{"verdict":"low-risk|review-required|high-risk","summary":"string","findings":[{"severity":"info|low|medium|high|critical","category":"string","evidence":"string","explanation":"string"}],"relocation":{"safe":true,"reason":"string"}}', ...prompt };
}

export async function importReviewResult(options: { stateDir?: string; hash: string; model: string; result: unknown }): Promise<Review> {
  if (!options.model.trim()) throw new Error('A model label is required for external reviews');
  const stateDir = stateOf(options.stateDir);
  const manifest = await readManifest(stateDir);
  if (manifest.errors.length) throw new Error('Cannot import a review into a manifest containing scan errors');
  const artifact = manifest.artifacts.find((item) => item.sha256 === options.hash);
  if (!artifact) throw new Error(`Hash is not present in current manifest: ${options.hash}`);
  strictUtf8(await readSource(stateDir, artifact.sha256), artifact);
  const normalized = validateReviewResult(options.result);
  const fingerprint = reviewFingerprint(artifact.sha256, 'external', options.model, PROMPT_VERSION, POLICY_VERSION);
  const existing = await readReview(stateDir, fingerprint);
  if (existing) {
    const prior = { verdict: existing.verdict, summary: existing.summary, findings: existing.findings, relocation: existing.relocation };
    if (JSON.stringify(prior) !== JSON.stringify(normalized)) throw new Error('A review already exists for this fingerprint and cannot be replaced');
    return existing;
  }
  const item: Review = { ...normalized, schemaVersion: 1, fingerprint, sha256: artifact.sha256, provider: 'external', model: options.model, promptVersion: PROMPT_VERSION, policyVersion: POLICY_VERSION, createdAt: new Date().toISOString() };
  await writeReview(stateDir, item);
  await appendEvent(stateDir, { type: 'review-import', at: item.createdAt, sha256: item.sha256, fingerprint, provider: 'external', model: item.model });
  await writeReport(stateDir, manifest);
  return item;
}
