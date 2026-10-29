import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { readSource } from './store.js';
import { parseReferences } from './discovery.js';
import type { Artifact } from './types.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Range = { startOffset: number; endOffset: number };

function valueRange(html: string, range: Range): { start: number; end: number } {
  const token = html.slice(range.startOffset, range.endOffset);
  const eq = token.indexOf('=');
  if (eq < 0) throw new Error('cannot locate HTML attribute value');
  const afterEq = token.slice(eq + 1);
  const trimStart = afterEq.length - afterEq.trimStart().length;
  const trimmed = afterEq.trimStart();
  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : '';
  return { start: range.startOffset + eq + 1 + trimStart + (quote ? 1 : 0), end: range.endOffset - (quote ? 1 : 0) };
}

function patchAttribute(html: string, range: Range, name: string, value: string): { start: number; end: number; value: string } {
  const token = html.slice(range.startOffset, range.endOffset);
  if (!token.includes('=')) return { start: range.startOffset, end: range.endOffset, value: `${name}="${value}"` };
  return { ...valueRange(html, range), value };
}

function checkedPublicPath(publicPath: string): string {
  if (publicPath.startsWith('/') || publicPath.startsWith('\\') || path.isAbsolute(publicPath) || path.win32.isAbsolute(publicPath)) throw new Error(`unsafe public path: ${publicPath}`);
  const normalized = publicPath.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw new Error(`unsafe public path: ${publicPath}`);
  return normalized;
}

async function assertSafeWithin(root: string, target: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(target);
  if (!absolute.startsWith(absoluteRoot + path.sep) && absolute !== absoluteRoot) throw new Error(`destination escapes public directory: ${absolute}`);
  const parts = path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean);
  let current = absoluteRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = path.join(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`symlink destination is not allowed: ${current}`);
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`destination ancestor is not a directory: ${current}`);
      if (index === parts.length - 1 && !info.isFile()) throw new Error(`destination is not a regular file: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function walk(node: Node, visit: (el: Element) => void): void {
  if ('tagName' in node) visit(node as Element);
  if ('childNodes' in node) for (const child of node.childNodes) walk(child, visit);
  if ('content' in node && node.content) walk(node.content, visit);
}

function attrPatches(html: string, pageUrl: string, artifacts: Artifact[], publicPath: string): Array<{ start: number; end: number; value: string }> {
  const safePublicPath = checkedPublicPath(publicPath);
  const refs = parseReferences(html, pageUrl);
  const byUrl = new Map(artifacts.map(a => [a.url, a]));
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const nodes: Element[] = [];
  walk(doc, n => nodes.push(n));
  const patches: Array<{ start: number; end: number; value: string }> = [];
  let refIndex = 0;
  for (const node of nodes) {
    const location = node.sourceCodeLocation;
    if (!location?.attrs || !location.startTag) continue;
    const kind = node.tagName === 'script'
      ? node.attrs.find(a => a.name === 'src') ? (node.attrs.find(a => a.name === 'type')?.value.trim().toLowerCase() === 'module' ? 'module' : 'classic') : undefined
      : node.tagName === 'link' && node.attrs.find(a => a.name === 'rel')?.value.toLowerCase().split(/\s+/).includes('modulepreload') ? 'preload' : undefined;
    if (!kind) continue;
    const attr = kind === 'preload' ? 'href' : 'src';
    const attrLoc = location.attrs[attr] as Range | undefined;
    if (!attrLoc) continue;
    const ref = refs[refIndex++];
    if (!ref) continue;
    const artifact = byUrl.get(ref.url);
    if (!artifact) continue;
    const value = `/${safePublicPath}/${artifact.sha256}.js`;
    patches.push(patchAttribute(html, attrLoc, attr, value));
    const integrityLoc = location.attrs.integrity as Range | undefined;
    if (integrityLoc) patches.push(patchAttribute(html, integrityLoc, 'integrity', artifact.sri));
    const crossoriginLoc = location.attrs.crossorigin as Range | undefined;
    if (artifact.thirdParty && crossoriginLoc) patches.push(patchAttribute(html, crossoriginLoc, 'crossorigin', 'anonymous'));
    const missing: string[] = [];
    if (!integrityLoc) missing.push(` integrity="${artifact.sri}"`);
    if (artifact.thirdParty && !crossoriginLoc) missing.push(' crossorigin="anonymous"');
    if (missing.length) {
      const tagEnd = location.startTag.endOffset;
      let insertion = tagEnd - 1;
      if (html[insertion - 1] === '/') insertion -= 1;
      patches.push({ start: insertion, end: insertion, value: missing.join('') });
    }
  }
  return patches.sort((a, b) => b.start - a.start);
}

export function rewriteHtml(html: string, pageUrl: string, artifacts: Artifact[], publicPath: string): string {
  const patches = attrPatches(html, pageUrl, artifacts, publicPath);
  let output = html;
  let lastStart = html.length + 1;
  for (const patch of patches) {
    if (patch.end > lastStart) throw new Error('overlapping HTML rewrite locations');
    output = output.slice(0, patch.start) + patch.value + output.slice(patch.end);
    lastStart = patch.start;
  }
  return output;
}

export async function vendorArtifacts(stateDir: string, artifacts: Artifact[], publicDir: string, publicPath = 'vendor/script-harbor'): Promise<Record<string, string>> {
  const safePublicPath = checkedPublicPath(publicPath);
  const root = path.resolve(publicDir);
  const directory = path.resolve(root, safePublicPath);
  if (!directory.startsWith(root + path.sep)) throw new Error('vendor path escapes public directory');
  const copies: Array<{ file: string; body: Buffer; url: string; publicUrl: string }> = [];
  const originals = new Map<string, Buffer | undefined>();
  const result: Record<string, string> = {};
  for (const artifact of artifacts) {
    const body = await readSource(stateDir, artifact.sha256);
    if (body.byteLength !== artifact.bytes) throw new Error(`source size mismatch for ${artifact.url}`);
    const file = path.join(directory, `${artifact.sha256}.js`);
    copies.push({ file, body, url: artifact.url, publicUrl: `/${safePublicPath}/${artifact.sha256}.js` });
    result[artifact.url] = `/${safePublicPath}/${artifact.sha256}.js`;
  }
  for (const copy of copies) {
    await assertSafeWithin(root, copy.file);
    try { originals.set(copy.file, await readFile(copy.file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; originals.set(copy.file, undefined); }
  }
  const staged: Array<{ temp: string; file: string }> = [];
  const written: string[] = [];
  try {
    for (const copy of copies) {
      await mkdir(path.dirname(copy.file), { recursive: true });
      await assertSafeWithin(root, copy.file);
      const temp = `${copy.file}.script-harbor-${randomUUID()}.tmp`;
      await writeFile(temp, copy.body, { flag: 'wx' });
      staged.push({ temp, file: copy.file });
    }
    for (const item of staged) { await rename(item.temp, item.file); written.push(item.file); }
  } catch (error) {
    for (const item of staged) await rm(item.temp, { force: true }).catch(() => undefined);
    for (const file of written.reverse()) {
      const previous = originals.get(file);
      if (previous === undefined) await rm(file, { force: true }).catch(() => undefined);
      else await writeFile(file, previous).catch(() => undefined);
    }
    throw error;
  }
  return result;
}

async function walkHtml(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new Error(`symlink is not allowed in protected output: ${file}`);
      if (ent.isDirectory()) await visit(file);
      else if (ent.isFile() && /\.html?$/i.test(ent.name)) files.push(file);
    }
  }
  await visit(root);
  return files.sort();
}

export async function protectDirectory(dir: string, origin: string, stateDir: string, artifacts: Artifact[], publicPath = 'vendor/script-harbor'): Promise<void> {
  const safePublicPath = checkedPublicPath(publicPath);
  const root = path.resolve(dir);
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`protected output is not a real directory: ${root}`);
  const files = await walkHtml(root);
  const originUrl = new URL(origin);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password) throw new Error('origin must be an HTTP(S) URL without credentials');
  const plans: Array<{ file: string; before: Buffer; after: Buffer }> = [];
  const copies: Array<{ file: string; body: Buffer }> = [];
  const destinations = new Set<string>();
  for (const artifact of artifacts) {
    const body = await readSource(stateDir, artifact.sha256);
    if (body.byteLength !== artifact.bytes) throw new Error(`source size mismatch for ${artifact.url}`);
    const dest = path.resolve(root, safePublicPath, `${artifact.sha256}.js`);
    if (!dest.startsWith(root + path.sep)) throw new Error(`vendor path escapes output directory: ${dest}`);
    destinations.add(dest);
    copies.push({ file: dest, body });
  }
  for (const file of files) {
    const before = await readFile(file);
    const html = before.toString('utf8');
    const pageUrl = new URL(path.relative(root, file).split(path.sep).join('/'), originUrl).href;
    // Parsing and URL validation for every page completes before the first write.
    parseReferences(html, pageUrl);
    const after = Buffer.from(rewriteHtml(html, pageUrl, artifacts, safePublicPath));
    plans.push({ file, before, after });
  }
  for (const dest of destinations) {
    const relative = path.relative(root, dest).split(path.sep);
    let cursor = root;
    for (const segment of relative.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      try { const info = await lstat(cursor); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe vendor path component: ${cursor}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try {
      const info = await lstat(dest);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`unsafe vendor destination: ${dest}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const originals = new Map<string, Buffer | undefined>();
  for (const plan of plans) originals.set(plan.file, plan.before);
  for (const copy of copies) {
    try { originals.set(copy.file, await readFile(copy.file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; originals.set(copy.file, undefined); }
  }
  const written: string[] = [];
  const staged: Array<{ temp: string; file: string }> = [];
  try {
    for (const plan of plans) {
      const temp = `${plan.file}.script-harbor-${randomUUID()}.tmp`;
      await writeFile(temp, plan.after);
      staged.push({ temp, file: plan.file });
    }
    for (const copy of copies) {
      await mkdir(path.dirname(copy.file), { recursive: true });
      const temp = `${copy.file}.script-harbor-${randomUUID()}.tmp`;
      await writeFile(temp, copy.body);
      staged.push({ temp, file: copy.file });
    }
    for (const item of staged) { await rename(item.temp, item.file); written.push(item.file); }
  } catch (error) {
    for (const item of staged) await rm(item.temp, { force: true }).catch(() => undefined);
    for (const file of written.reverse()) {
      const previous = originals.get(file);
      if (previous === undefined) await rm(file, { force: true }).catch(() => undefined);
      else await writeFile(file, previous).catch(() => undefined);
    }
    throw error;
  }
}
