import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import { fetchResource } from '../src/network.js';
import { approve, check, protect, review, scan } from '../src/pipeline.js';

const reviewedResult = {
  verdict: 'low-risk',
  summary: 'The fixture writes a fixed label into the test page.',
  findings: [],
  relocation: { safe: true, reason: 'No origin-sensitive behavior was detected in this fixture.' },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('runtime capture, approval, protect, drift checks, and local-only browser execution', { timeout: 90_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-e2e-'));
  const stateDir = path.join(tempRoot, '.script-harbor');
  const outputDir = path.join(tempRoot, 'dist');
  const artifactsDir = path.resolve('artifacts/e2e', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
  await mkdir(outputDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  let scriptBody = `document.querySelector('#result').textContent = 'executed captured bytes';`;
  let vendorOrigin = '';
  const upstream = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><body><p id="result">pending</p><script src="${vendorOrigin}/vendor.js"></script></body></html>`);
      return;
    }
    response.writeHead(404).end();
  });
  const vendor = createServer((request, response) => {
    if (request.url === '/vendor.js') {
      response.setHeader('content-type', 'application/javascript; charset=utf-8');
      response.end(scriptBody);
      return;
    }
    response.writeHead(404).end();
  });

  const app = createServer(async (request, response) => {
    const requested = request.url === '/' ? 'index.html' : decodeURIComponent(request.url!.split('?', 1)[0]!.replace(/^\//, ''));
    const file = path.resolve(outputDir, requested);
    if (!file.startsWith(`${outputDir}${path.sep}`)) { response.writeHead(400).end(); return; }
    try {
      const body = await readFile(file);
      response.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  let chromiumBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  try {
    const upstreamOrigin = await listen(upstream);
    vendorOrigin = await listen(vendor);
    const appOrigin = await listen(app);
    const upstreamPage = `${upstreamOrigin}/`;
    const scriptUrl = `${vendorOrigin}/vendor.js`;
    const html = `<!doctype html><html><body><p id="result">pending</p><script src="${scriptUrl}" integrity="sha256-stale" crossorigin="use-credentials"></script></body></html>`;
    await writeFile(path.join(outputDir, 'index.html'), html);

    await assert.rejects(fetchResource(scriptUrl), /Blocked non-public address/);
    const captured = await scan({ urls: [upstreamPage], stateDir, allowLocal: true, runtime: true, observeMs: 100 });
    assert.equal(captured.errors.length, 0, captured.errors.join('\n'));
    const artifact = captured.artifacts.find((item) => item.url === scriptUrl && item.kind === 'classic');
    assert.ok(artifact, 'static pass should capture the declared upstream script');
    assert.ok(captured.artifacts.some((item) => item.url === scriptUrl && item.kind === 'runtime'), 'runtime pass should observe the executed script response');

    await assert.rejects(check({ stateDir }), /No matching current review|No current review|No human approval/);
    let reviewCalls = 0;
    const provider = createServer(async (request, response) => {
      reviewCalls += 1;
      assert.equal(request.method, 'POST');
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.match(body, /executed captured bytes/);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reviewedResult) } }] }));
    });
    const providerEndpoint = await listen(provider);
    try {
      await review({ provider: 'openrouter', model: 'fixture-model', apiKey: 'fixture-only', endpoint: `${providerEndpoint}/review`, stateDir });
      await review({ provider: 'openrouter', model: 'fixture-model', apiKey: 'fixture-only', endpoint: `${providerEndpoint}/review`, stateDir });
      assert.equal(reviewCalls, 1, 'identical bytes and review fingerprint should use the cached review');
    } finally {
      await close(provider);
    }

    await approve(artifact.sha256, { stateDir, reviewer: 'E2E reviewer', reason: 'Deterministic local fixture', allowRehost: true });
    await protect({ dir: outputDir, origin: upstreamOrigin, stateDir, allowLocal: true });
    const protectedHtml = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    const vendorPath = `/vendor/script-harbor/${artifact.sha256}.js`;
    assert.ok(protectedHtml.includes(vendorPath), 'HTML should reference the content-addressed local script');
    assert.ok(protectedHtml.includes(`integrity="${artifact.sri}"`), 'existing integrity should be replaced with the captured SRI');
    assert.ok(protectedHtml.includes('crossorigin="anonymous"'), 'third-party crossorigin mode should be normalized');
    await protect({ dir: outputDir, origin: upstreamOrigin, stateDir, allowLocal: true });
    assert.equal(await readFile(path.join(outputDir, 'index.html'), 'utf8'), protectedHtml, 'a repeated protect should leave the build unchanged');

    scriptBody += `document.body.dataset.changed = 'yes';`;
    await assert.rejects(check({ stateDir, live: true, allowLocal: true }), /Upstream drift detected/);
    scriptBody = `document.querySelector('#result').textContent = 'executed captured bytes';`;
    await check({ stateDir, live: true, allowLocal: true });

    const capturedFile = path.join(stateDir, 'sources', `${artifact.sha256}.js`);
    const exactBytes = await readFile(capturedFile);
    assert.equal(createHash('sha256').update(exactBytes).digest('hex'), artifact.sha256);
    await writeFile(capturedFile, Buffer.from('tampered source'));
    await assert.rejects(check({ stateDir }), /hash|SRI mismatch|integrity check failed/i);
    await writeFile(capturedFile, exactBytes);

    await close(upstream);
    await close(vendor);
    chromiumBrowser = await chromium.launch({ headless: true, chromiumSandbox: true });
    context = await chromiumBrowser.newContext({ recordVideo: { dir: artifactsDir } });
    const page = await context.newPage();
    await page.goto(`${appOrigin}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#result')?.textContent === 'executed captured bytes');
    assert.equal(await page.locator('#result').textContent(), 'executed captured bytes');
    assert.equal(await page.evaluate(() => document.querySelector('script')?.getAttribute('src')), vendorPath);
    await page.screenshot({ path: path.join(artifactsDir, 'runtime-e2e.png'), fullPage: true });
    await page.close();
    await context.close();
    context = undefined;
  } finally {
    await context?.close().catch(() => undefined);
    await chromiumBrowser?.close().catch(() => undefined);
    await close(upstream).catch(() => undefined);
    await close(vendor).catch(() => undefined);
    await close(app).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
