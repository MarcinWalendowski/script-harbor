import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readFile, readdir, rename, unlink, appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { POLICY_VERSION, PROMPT_VERSION } from './types.js';
import type { Approval, Manifest, Provider, Review, ReviewResult } from './types.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprintSchema = sha256Schema;
const timestampSchema = z.string().datetime({ offset: true });
const nonempty = z.string().min(1);
const httpUrlSchema = z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const providerSchema = z.enum(['openrouter', 'claude', 'codex', 'external']);
const artifactSchema = z.object({
  url: z.string().url(), finalUrl: z.string().url(), sha256: sha256Schema,
  sri: z.string().regex(/^sha384-[A-Za-z0-9+/]{64}$/), bytes: z.number().int().nonnegative(),
  contentType: nonempty, pages: z.array(httpUrlSchema),
  kind: z.enum(['classic', 'module', 'preload', 'runtime']), thirdParty: z.boolean(),
  relocation: z.enum(['eligible', 'manual']), relocationReasons: z.array(z.string()),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), createdAt: timestampSchema, origins: z.array(httpUrlSchema),
  artifacts: z.array(artifactSchema), localScripts: z.array(nonempty),
  coverage: z.object({ mode: z.enum(['static', 'runtime']), pages: z.array(httpUrlSchema), limitations: z.array(z.string()) }).strict(),
  errors: z.array(z.string()),
}).strict();
const findingSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']), category: nonempty,
  evidence: z.string(), explanation: z.string(),
}).strict();
const reviewResultSchema = z.object({
  verdict: z.enum(['low-risk', 'review-required', 'high-risk']), summary: z.string(),
  findings: z.array(findingSchema), relocation: z.object({ safe: z.boolean(), reason: z.string() }).strict(),
}).strict();
const reviewSchema = reviewResultSchema.extend({
  schemaVersion: z.literal(1), fingerprint: fingerprintSchema, sha256: sha256Schema,
  provider: providerSchema, model: nonempty, promptVersion: nonempty, policyVersion: nonempty,
  createdAt: timestampSchema,
}).strict();
const approvalSchema = z.object({
  sha256: sha256Schema, fingerprint: fingerprintSchema, reviewer: nonempty, reason: nonempty,
  approvedAt: timestampSchema, allowRehost: z.boolean(), urls: z.array(httpUrlSchema).min(1),
}).strict();

function parseJson<T>(text: string, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }); }
  return schema.parse(value);
}

async function assertNoSymlinks(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        const resolved = await realpath(current);
        if (resolved !== '/private/var' && resolved !== '/private/tmp') throw new Error(`Refusing symlink path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function ensureParent(target: string): Promise<void> {
  const parent = path.dirname(path.resolve(target));
  await mkdir(parent, { recursive: true });
  await assertNoSymlinks(parent);
}

export function hashBytes(body: Uint8Array): { sha256: string; sri: string } {
  return {
    sha256: createHash('sha256').update(body).digest('hex'),
    sri: `sha384-${createHash('sha384').update(body).digest('base64')}`,
  };
}

export async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  await ensureParent(target);
  await assertNoSymlinks(target);
  const temp = `${path.resolve(target)}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path.resolve(target));
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function saveSource(stateDir: string, body: Buffer): Promise<{ sha256: string; sri: string }> {
  const hashes = hashBytes(body);
  const target = path.join(stateDir, 'sources', `${hashes.sha256}.js`);
  try {
    const existing = await readSource(stateDir, hashes.sha256);
    if (!existing.equals(body)) throw new Error('Source hash collision detected');
  } catch (error) {
    if (!(error instanceof Error && error.message === 'Source not found')) throw error;
    await atomicWrite(target, body);
  }
  return hashes;
}

export async function readSource(stateDir: string, hash: string): Promise<Buffer> {
  const validHash = sha256Schema.parse(hash);
  const file = path.join(stateDir, 'sources', `${validHash}.js`);
  await assertNoSymlinks(file);
  let body: Buffer;
  try { body = await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Source not found', { cause: error });
    throw error;
  }
  if (hashBytes(body).sha256 !== validHash) throw new Error(`Source integrity check failed: ${validHash}`);
  return body;
}

export async function readManifest(stateDir: string): Promise<Manifest> {
  const file = path.join(stateDir, 'manifest.json');
  await assertNoSymlinks(file);
  return parseJson(await readFile(file, 'utf8'), manifestSchema, 'Manifest');
}

export async function writeManifest(stateDir: string, manifest: Manifest): Promise<void> {
  const valid = manifestSchema.parse(manifest);
  await atomicWrite(path.join(stateDir, 'manifest.json'), `${JSON.stringify(valid, null, 2)}\n`);
}

export function reviewFingerprint(hash: string, provider: Provider, model: string, promptVersion = PROMPT_VERSION, policyVersion = POLICY_VERSION): string {
  const validHash = sha256Schema.parse(hash);
  const validProvider = providerSchema.parse(provider);
  const validModel = nonempty.parse(model);
  const validPrompt = nonempty.parse(promptVersion);
  const validPolicy = nonempty.parse(policyVersion);
  return createHash('sha256').update(JSON.stringify([validHash, validProvider, validModel, validPrompt, validPolicy])).digest('hex');
}

function validateReview(value: unknown): Review {
  const review = reviewSchema.parse(value);
  if (review.fingerprint !== reviewFingerprint(review.sha256, review.provider, review.model, review.promptVersion, review.policyVersion)) {
    throw new Error('Review fingerprint does not match its fields');
  }
  return review;
}

export function validateReviewResult(value: unknown): ReviewResult {
  return reviewResultSchema.parse(value);
}

export async function readReview(stateDir: string, fingerprint: string): Promise<Review | undefined> {
  const validFingerprint = fingerprintSchema.parse(fingerprint);
  const file = path.join(stateDir, 'reviews', `${validFingerprint}.json`);
  await assertNoSymlinks(file);
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const review = parseJson(text, reviewSchema, 'Review');
  const verified = validateReview(review);
  if (verified.fingerprint !== validFingerprint) throw new Error('Review filename does not match its fingerprint');
  return verified;
}

export async function writeReview(stateDir: string, review: Review): Promise<void> {
  const valid = validateReview(review);
  await atomicWrite(path.join(stateDir, 'reviews', `${valid.fingerprint}.json`), `${JSON.stringify(valid, null, 2)}\n`);
}

export async function readAllReviews(stateDir: string): Promise<Review[]> {
  const dir = path.join(stateDir, 'reviews');
  await assertNoSymlinks(dir);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const output: Review[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fingerprint = entry.name.slice(0, -5);
    if (!fingerprintSchema.safeParse(fingerprint).success) continue;
    try {
      const review = await readReview(stateDir, fingerprint);
      if (review) output.push(review);
    } catch { /* Invalid cache entries are not enumerable. */ }
  }
  return output;
}

export async function readApprovals(stateDir: string): Promise<Approval[]> {
  const file = path.join(stateDir, 'approvals.json');
  await assertNoSymlinks(file);
  let data: string;
  try { data = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return z.array(approvalSchema).parse(JSON.parse(data) as unknown);
}

export async function writeApprovals(stateDir: string, approvals: Approval[]): Promise<void> {
  const valid = z.array(approvalSchema).parse(approvals);
  await atomicWrite(path.join(stateDir, 'approvals.json'), `${JSON.stringify(valid, null, 2)}\n`);
}

export async function appendEvent(stateDir: string, event: Record<string, unknown>): Promise<void> {
  const file = path.join(stateDir, 'events.jsonl');
  await ensureParent(file);
  await assertNoSymlinks(file);
  const serialized = JSON.stringify(event);
  if (serialized === undefined) throw new Error('Event must be JSON serializable');
  await appendFile(file, `${serialized}\n`, { mode: 0o600 });
}
