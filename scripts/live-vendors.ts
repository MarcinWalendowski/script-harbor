import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fetchResource } from '../src/network.js';
import { hashBytes } from '../src/store.js';
import { scan } from '../src/pipeline.js';

const vendors = [
  {
    name: 'sentry',
    url: 'https://browser.sentry-cdn.com/11.10.0/bundle.tracing.min.js',
    reference: 'https://sentry.io/for/javascript/',
  },
  {
    name: 'google-tag-manager',
    url: 'https://www.googletagmanager.com/gtm.js?id=GTM-MPHTW35',
    reference: 'https://marketingplatform.google.com/about/tag-manager/',
  },
  {
    name: 'microsoft-clarity',
    url: 'https://www.clarity.ms/tag/3t0wlogvdz',
    reference: 'https://clarity.microsoft.com/',
  },
] as const;

const outputDir = resolve('artifacts/live-vendors');
await mkdir(outputDir, { recursive: true });
const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'script-harbor-vendors-'));

let failures = 0;
try {
  const fixtureOrigin = 'https://script-harbor-fixture.invalid';
  const tags = vendors.map((vendor) => `<script src="${vendor.url}"></script>`).join('\n');
  await writeFile(resolve(fixtureRoot, 'index.html'), `<!doctype html><html><body>${tags}</body></html>`);
  const manifest = await scan({ dir: fixtureRoot, origin: fixtureOrigin, stateDir: resolve(fixtureRoot, '.script-harbor') });
  if (manifest.errors.length) throw new Error(manifest.errors.join('; '));

  for (const vendor of vendors) {
    try {
      const artifact = manifest.artifacts.find((item) => item.url === vendor.url);
      if (!artifact) throw new Error('static scan did not capture this script URL');
      const response = await fetchResource(vendor.url);
      const responseHash = hashBytes(response.body).sha256;
      const capture = {
        capturedAt: new Date().toISOString(),
        vendor: vendor.name,
        reference: vendor.reference,
        requestedUrl: response.url,
        finalUrl: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
        bytes: response.body.byteLength,
        sha256: responseHash,
        scanSha256: artifact.sha256,
        scanMatchesStatusCapture: responseHash === artifact.sha256,
        executed: false,
        approved: false,
      };
      const path = resolve(outputDir, `${vendor.name}.json`);
      await writeFile(path, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${vendor.name}: HTTP ${response.status} ${responseHash} (${response.body.byteLength} bytes; scanner ${artifact.sha256}) -> ${path}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`${vendor.name}: capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

if (failures > 0) process.exitCode = 1;
