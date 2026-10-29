import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap, ParserError } from 'parse5';
import { chromium, type Page } from 'playwright';
import { fetchResource } from './network.js';
import { saveSource } from './store.js';
import type { Artifact, Manifest, ScanOptions, ScriptReference } from './types.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const SCRIPT_LIMIT = 100;
const REQUEST_LIMIT = 200;
const SOURCE_LIMIT = 5 * 1024 * 1024;
const MAX_SCRIPT_LIMIT = 1000;
const MAX_REQUEST_LIMIT = 2000;

function boundedLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  return limit;
}

function walk(node: Node, visit: (element: Element) => void): void {
  if ('tagName' in node) visit(node as Element);
  if ('childNodes' in node) for (const child of node.childNodes) walk(child, visit);
  if ('content' in node && node.content) walk(node.content, visit);
}

function checkedHttpUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be an HTTP(S) URL without credentials`);
  return url;
}

function parseHtml(html: string): { refs: ScriptReference[]; base?: string; errors: string[] } {
  const errors: string[] = [];
  const doc = parse(html, { sourceCodeLocationInfo: true, onParseError: (error: ParserError) => {
    if (error.code === 'duplicate-attribute') errors.push(`duplicate HTML attribute at offset ${error.startOffset}`);
  } });
  const elements: Element[] = [];
  walk(doc, element => elements.push(element));
  let base: string | undefined;
  const refs: ScriptReference[] = [];
  for (const el of elements) {
    const attrs: Record<string, string> = {};
    for (const attr of el.attrs) attrs[attr.name] = attr.value;
    if (el.tagName === 'base' && attrs.href !== undefined && base === undefined) base = attrs.href;
    let key: string | undefined;
    let kind: ScriptReference['kind'] | undefined;
    if (el.tagName === 'script' && attrs.src !== undefined) {
      key = 'src'; kind = attrs.type?.trim().toLowerCase() === 'module' ? 'module' : 'classic';
    } else if (el.tagName === 'link' && attrs.href !== undefined && attrs.rel?.toLowerCase().split(/\s+/).includes('modulepreload')) {
      key = 'href'; kind = 'preload';
    }
    const loc = el.sourceCodeLocation;
    if (!key || !kind || !loc?.startTag || !loc.attrs?.[key]) continue;
    // Duplicate attributes are rejected at page level; retaining the first value here is safe.
    refs.push({ url: attrs[key]!, kind, start: loc.startTag.startOffset, end: loc.startTag.endOffset, tag: el.tagName, attributes: attrs });
  }
  return { refs, base, errors };
}

export function parseReferences(html: string, pageUrl: string): ScriptReference[] {
  const parsed = parseHtml(html);
  if (parsed.errors.length) throw new Error(parsed.errors.join('; '));
  const page = new URL(pageUrl);
  const base = parsed.base ? new URL(parsed.base, page) : page;
  if (base.origin !== page.origin) throw new Error(`cross-origin base URL is not supported: ${base.href}`);
  return parsed.refs.map(ref => ({ ...ref, url: new URL(ref.url, base).href }));
}

export function relocationReasons(source: string, kind: Artifact['kind']): string[] {
  const reasons: string[] = [];
  if (kind === 'module' || kind === 'preload') reasons.push('module dependency graphs are not rewritten');
  if (/\b(?:import\s*\(|import\s+(?:[^'"\n]+?\s+from\s*)?['"]|export\s+[^\n]*?\s+from\s*['"])/.test(source)) reasons.push('module imports may depend on the original URL');
  if (/\bdocument\s*\.\s*createElement\s*\(\s*['"]script['"]\s*\)|\b(?:currentScript\s*\.\s*src|import\s*\.\s*meta\s*\.\s*url)\b/i.test(source)) reasons.push('dynamic script creation or source-relative URL behavior requires manual review');
  if (/\b(?:document\.write|importScripts|new\s+(?:Shared)?Worker\s*\(|serviceWorker\.register|eval\s*\(|new\s+Function\s*\()/i.test(source)) reasons.push('dynamic, worker, or origin-sensitive loading requires manual review');
  if (/\b(?:location\.(?:origin|host|hostname)|document\.domain|window\.origin)\b/.test(source)) reasons.push('source reads the page origin');
  if (/(?:https?:)?\/\//i.test(source) && /(?:src|href|import|fetch|XMLHttpRequest|WebSocket)\s*(?:=|\(|:)/i.test(source)) reasons.push('source contains possible remote resource loading');
  return [...new Set(reasons)];
}

function decodeScript(body: Buffer, contentType: string): string {
  if (body.byteLength > SOURCE_LIMIT) throw new Error(`script exceeds ${SOURCE_LIMIT} byte limit`);
  const [mime = '', ...parameters] = contentType.split(';');
  if (contentType && !/^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/plain|application\/octet-stream)$/i.test(mime.trim())) throw new Error(`unexpected script MIME type: ${contentType}`);
  const charset = parameters.map(p => /^\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(p)?.[1]).find(Boolean);
  if (charset && !/^utf-?8$/i.test(charset)) throw new Error(`unsupported script charset: ${charset}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new Error('script is not valid UTF-8'); }
}

async function htmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) await visit(full);
      else if (ent.isFile() && /\.html?$/i.test(ent.name)) out.push(full);
    }
  }
  await visit(root);
  return out.sort();
}

async function hasSymlinkPath(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  return false;
}

export async function discover(options: ScanOptions): Promise<Manifest> {
  const maxScripts = boundedLimit(options.maxScripts, SCRIPT_LIMIT, MAX_SCRIPT_LIMIT, 'maxScripts');
  const maxRequests = boundedLimit(options.maxRequests, REQUEST_LIMIT, MAX_REQUEST_LIMIT, 'maxRequests');
  const stateDir = options.stateDir ?? '.script-harbor';
  const errors: string[] = [];
  const limitations: string[] = ['coverage is limited to supplied pages and captured responses', 'computed URLs and code paths not observed during this scan may be missed'];
  if (options.allowLocal) limitations.push('LOCAL NETWORK ACCESS IS ENABLED FOR THIS SCAN; only loopback addresses are allowed');
  const artifacts = new Map<string, Artifact>();
  const localScripts = new Set<string>();
  const pages: string[] = [];
  const tasks: Array<{ page: string; ref: ScriptReference }> = [];
  let origin: URL | undefined;
  try { if (options.origin) origin = checkedHttpUrl(options.origin, 'origin'); } catch (error) { errors.push(`invalid origin: ${String(error)}`); }

  if (options.dir) {
    if (!origin) errors.push('--dir requires a valid --origin');
    else {
      const root = path.resolve(options.dir);
      let rootSafe = true;
      try { if ((await lstat(root)).isSymbolicLink()) { errors.push(`scan directory is a symlink: ${root}`); rootSafe = false; } }
      catch (error) { errors.push(`cannot access scan directory ${root}: ${String(error)}`); rootSafe = false; }
      const initialErrorCount = errors.length;
      let beforeCount = 0;
      try { if (rootSafe) beforeCount = (await htmlFiles(root)).length; }
      catch (error) { errors.push(`cannot read scan directory: ${String(error)}`); }
      if (rootSafe && beforeCount === 0 && errors.length === initialErrorCount) errors.push(`no HTML pages found in scan directory: ${root}`);
      for (const file of beforeCount ? await htmlFiles(root) : []) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        const page = new URL(relative, origin).href;
        pages.push(page);
        try {
          const html = await readFile(file, 'utf8');
          const parsed = parseHtml(html);
          errors.push(...parsed.errors.map(e => `${page}: ${e}`));
          const base = parsed.base ? new URL(parsed.base, page) : new URL(page);
          if (base.origin !== origin.origin) { errors.push(`${page}: cross-origin base URL is not supported: ${base.href}`); continue; }
          for (const ref of parsed.refs) {
            try {
              const url = new URL(ref.url, base).href;
              if (new URL(url).origin === origin.origin) {
                const relativeResource = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
                const candidate = path.resolve(root, relativeResource);
                if (!candidate.startsWith(root + path.sep) && candidate !== root) { errors.push(`${page}: local script escapes scan directory`); continue; }
                if (await hasSymlinkPath(root, candidate)) { errors.push(`${page}: local script path traverses a symlink: ${url}`); continue; }
                try { const st = await import('node:fs/promises').then(fs => fs.lstat(candidate)); if (st.isSymbolicLink()) { errors.push(`${page}: local script is a symlink: ${url}`); continue; } if (st.isFile()) { localScripts.add(url); continue; } } catch { /* not a built local file; fetch below */ }
              }
              tasks.push({ page, ref: { ...ref, url } });
            } catch (error) { errors.push(`${page}: invalid script URL ${ref.url}: ${String(error)}`); }
          }
        } catch (error) { errors.push(`${page}: HTML read/parse failed: ${String(error)}`); }
      }
    }
  }
  for (const raw of options.urls ?? []) {
    try {
      const page = checkedHttpUrl(raw, 'page URL').href;
      pages.push(page);
      const response = await fetchResource(page, { allowLocal: options.allowLocal, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, maxBytes: Math.max(options.maxBytes ?? SOURCE_LIMIT, 2 * 1024 * 1024) });
      if (!/(?:text\/html|application\/xhtml\+xml)/i.test(response.contentType.split(';', 1)[0] ?? '')) throw new Error(`unexpected page MIME type: ${response.contentType}`);
      const charset = /(?:^|;)\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(response.contentType)?.[1];
      if (charset && !/^utf-?8$/i.test(charset)) throw new Error(`unsupported page charset: ${charset}`);
      const html = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      const parsed = parseHtml(html);
      errors.push(...parsed.errors.map(e => `${page}: ${e}`));
      const pageBase = parsed.base ? new URL(parsed.base, response.finalUrl) : new URL(response.finalUrl);
      if (pageBase.origin !== new URL(response.finalUrl).origin) { errors.push(`${page}: cross-origin base URL is not supported: ${pageBase.href}`); continue; }
      for (const ref of parsed.refs) {
        try { tasks.push({ page, ref: { ...ref, url: new URL(ref.url, pageBase).href } }); }
        catch (error) { errors.push(`${page}: invalid script URL ${ref.url}: ${String(error)}`); }
      }
    } catch (error) { errors.push(`${raw}: page fetch/parse failed: ${String(error)}`); }
  }

  if (!options.dir && !(options.urls?.length)) errors.push('scan requires at least one --url or --dir input');

  if (tasks.length > maxScripts) errors.push(`script limit exceeded: found ${tasks.length}, limit ${maxScripts}`);
  const hashesByUrl = new Map<string, string>();
  for (const task of tasks.slice(0, maxScripts)) {
    const key = `${task.ref.url}\0${task.ref.kind}`;
    try {
      const response = await fetchResource(task.ref.url, { allowLocal: options.allowLocal, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, maxBytes: options.maxBytes ?? SOURCE_LIMIT });
      const source = decodeScript(response.body, response.contentType);
      const saved = await saveSource(stateDir, response.body);
      const reasons = relocationReasons(source, task.ref.kind);
      const priorHash = hashesByUrl.get(task.ref.url);
      if (priorHash && priorHash !== saved.sha256) {
        errors.push(`${task.page}: conflicting bytes captured for ${task.ref.url}`);
        continue;
      }
      hashesByUrl.set(task.ref.url, saved.sha256);
      const existing = artifacts.get(key);
      if (existing) { if (!existing.pages.includes(task.page)) existing.pages.push(task.page); continue; }
      artifacts.set(key, { url: task.ref.url, finalUrl: response.finalUrl, sha256: saved.sha256, sri: saved.sri, bytes: response.body.byteLength, contentType: response.contentType, pages: [task.page], kind: task.ref.kind, thirdParty: new URL(task.ref.url).origin !== new URL(task.page).origin, relocation: reasons.length ? 'manual' : 'eligible', relocationReasons: reasons });
    } catch (error) { errors.push(`${task.page}: failed to capture ${task.ref.url}: ${String(error)}`); }
  }

  if (options.runtime) {
    limitations.push('runtime observation executed page scripts in a disposable browser context; it is not OS isolation');
    const uniquePages = [...new Set(options.urls ?? [])];
    if (options.dir) errors.push('runtime observation is supported for --url pages only');
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true, chromiumSandbox: true });
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      const observed = new Map<string, Artifact>();
      const knownScriptUrls = new Set([...artifacts.values()].map(artifact => artifact.url));
      const auditedPages = new WeakMap<Page, string>();
      let requestCount = 0;
      let responseBytes = 0;
      const maxTotalBytes = 50 * 1024 * 1024;
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.method() !== 'GET') { await route.abort('blockedbyclient'); return; }
        if (++requestCount > maxRequests) { errors.push(`runtime request limit exceeded (${maxRequests})`); await route.abort('blockedbyclient'); return; }
        let auditedPage: string | undefined;
        try { auditedPage = auditedPages.get(request.frame().page()); }
        catch { auditedPage = undefined; }
        if (!auditedPage) {
          errors.push(`runtime request has no audited top-level page owner: ${request.url()}`);
          await route.abort('failed');
          return;
        }
        try {
          const result = await fetchResource(request.url(), { allowLocal: options.allowLocal, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects, maxBytes: options.maxBytes ?? SOURCE_LIMIT });
          if (new URL(result.finalUrl).href !== new URL(request.url()).href) {
            errors.push(`runtime redirect is not safely replayable at the original URL: ${request.url()} -> ${result.finalUrl}`);
            await route.abort('failed');
            return;
          }
          responseBytes += result.body.byteLength;
          if (responseBytes > maxTotalBytes) { errors.push(`runtime response byte limit exceeded (${maxTotalBytes})`); await route.abort('blockedbyclient'); return; }
          if (request.resourceType() === 'script') {
            const source = decodeScript(result.body, result.contentType);
            const saved = await saveSource(stateDir, result.body);
            const reasons = relocationReasons(source, 'runtime');
            const key = result.url;
            const priorHash = hashesByUrl.get(result.url);
            if (priorHash && priorHash !== saved.sha256) errors.push(`conflicting bytes captured in static/runtime scans for ${result.url}`);
            hashesByUrl.set(result.url, saved.sha256);
            const prior = observed.get(key);
            if (prior && prior.sha256 !== saved.sha256) errors.push(`conflicting runtime bytes captured for ${result.url}`);
            else if (prior) { if (!prior.pages.includes(auditedPage)) prior.pages.push(auditedPage); }
            else if (!knownScriptUrls.has(key) && knownScriptUrls.size >= maxScripts) errors.push(`runtime script limit exceeded (${maxScripts})`);
            else {
              knownScriptUrls.add(key);
              observed.set(key, { url: result.url, finalUrl: result.finalUrl, sha256: saved.sha256, sri: saved.sri, bytes: result.body.byteLength, contentType: result.contentType, pages: [auditedPage], kind: 'runtime', thirdParty: (() => { try { return new URL(result.url).origin !== new URL(auditedPage).origin; } catch { return true; } })(), relocation: reasons.length ? 'manual' : 'eligible', relocationReasons: reasons });
            }
          }
          await route.fulfill({ status: result.status, body: result.body, headers: { 'content-type': result.contentType, 'access-control-allow-origin': '*' } });
        } catch (error) { errors.push(`runtime failed to fetch ${request.url()}: ${String(error)}`); await route.abort('failed').catch(() => undefined); }
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      for (const rawPage of uniquePages) {
        const page = await context.newPage();
        try {
          const auditedPage = checkedHttpUrl(rawPage, 'runtime input page').href;
          auditedPages.set(page, auditedPage);
          await page.goto(auditedPage, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 20_000 });
          await page.waitForTimeout(Math.min(options.observeMs ?? 5_000, 30_000));
        } catch (error) { errors.push(`${rawPage}: runtime navigation/observation failed: ${String(error)}`); }
        finally { await page.close(); }
      }
      for (const [key, artifact] of observed) artifacts.set(`${key}\0runtime`, artifact);
      await context.close();
    } catch (error) { errors.push(`runtime browser capture failed: ${String(error)}`); }
    finally { await browser?.close().catch(() => undefined); }
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(), origins: [...new Set(pages.map(p => new URL(p).origin))], artifacts: [...artifacts.values()], localScripts: [...localScripts], coverage: { mode: options.runtime ? 'runtime' : 'static', pages, limitations }, errors };
}
