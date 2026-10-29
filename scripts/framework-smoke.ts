import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';

const execFile = promisify(execFileCallback);
const nodeDir = path.dirname(process.execPath);
const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}` };
const repoRoot = process.cwd();
const rootDist = path.join(repoRoot, 'dist');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-frameworks-'));
const packDir = path.join(tempRoot, 'package');
await mkdir(packDir, { recursive: true });

async function run(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const result = await execFile(command, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    throw new Error(`${command} ${args.join(' ')} failed (${detail.code ?? 'unknown'})\n${detail.stdout ?? ''}${detail.stderr ?? ''}`, { cause: error });
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function packageTarball(): Promise<string> {
  await readFile(path.join(rootDist, 'cli.js'));
  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], repoRoot);
  const files = (await readdir(packDir)).filter((file) => file.endsWith('.tgz'));
  assert.equal(files.length, 1, 'npm pack should create exactly one package tarball');
  return path.join(packDir, files[0]!);
}

async function setupFixture(options: { name: 'vite' | 'astro'; packageName: string; tarball: string; portUrl: string }): Promise<string> {
  const root = path.join(tempRoot, options.name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: `script-harbor-${options.name}-fixture`, private: true, type: 'module', scripts: { build: options.name === 'vite' ? 'vite build' : 'astro build' } }, null, 2)}\n`);

  if (options.name === 'vite') {
    await writeFile(path.join(root, 'index.html'), `<!doctype html><html><body><p id="result">pending</p><script src="${options.portUrl}/vendor.js" integrity="sha256-stale" crossorigin="use-credentials"></script></body></html>\n`);
  } else {
    const pages = path.join(root, 'src/pages');
    await mkdir(pages, { recursive: true });
    await writeFile(path.join(pages, 'index.astro'), `<!doctype html><html><body><p id="result">pending</p><script is:inline src="${options.portUrl}/vendor.js" integrity="sha256-stale" crossorigin="use-credentials"></script></body></html>\n`);
  }

  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', options.packageName, options.tarball], root);
  return root;
}

async function exercise(framework: 'vite' | 'astro', dependency: string, tarball: string): Promise<{ framework: string; version: string; hash: string; output: string }> {
  let source = `document.querySelector('#result').textContent = '${framework} captured fixture executed';`;
  const upstream = createServer((request, response) => {
    if (request.url === '/vendor.js') {
      response.setHeader('content-type', 'application/javascript; charset=utf-8');
      response.end(source);
      return;
    }
    response.writeHead(404).end();
  });
  try {
    const origin = await listen(upstream);
    const root = await setupFixture({ name: framework, packageName: dependency, tarball, portUrl: origin });
    const cli = path.join(root, 'node_modules/@marcinwalendowski/script-harbor/dist/cli.js');

    await run(process.execPath, [cli, 'init', '--framework', framework, '--origin', 'https://fixture.example'], root);
    const packageJsonPath = path.join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts: Record<string, string> };
    packageJson.scripts['script-harbor:protect'] += ' --allow-local';
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    await run('npm', ['run', 'build:unprotected'], root);
    const outputDir = path.join(root, 'dist');
    await run(process.execPath, [cli, 'scan', '--dir', outputDir, '--origin', 'https://fixture.example', '--allow-local'], root);
    const stateDir = path.join(root, '.script-harbor');
    const manifest = JSON.parse(await readFile(path.join(stateDir, 'manifest.json'), 'utf8')) as { artifacts: Array<{ url: string; sha256: string; sri: string }> };
    const artifact = manifest.artifacts.find((item) => item.url === `${origin}/vendor.js`);
    assert.ok(artifact, `${framework}: scan should capture the fixture script from the actual build output`);

    const reviewPath = path.join(root, 'fixture-review.json');
    await writeFile(reviewPath, `${JSON.stringify({
      verdict: 'low-risk',
      summary: `Harmless ${framework} integration fixture for build smoke validation.`,
      findings: [],
      relocation: { safe: true, reason: 'The fixture writes a fixed text value and has no external dependencies.' },
    }, null, 2)}\n`);
    await run(process.execPath, [cli, 'import-review', '--hash', artifact.sha256, '--model', 'framework-smoke-fixture', '--file', reviewPath], root);
    await run(process.execPath, [cli, 'approve', artifact.sha256, '--reviewer', 'Framework smoke test', '--reason', 'Local harmless fixture only', '--allow-rehost'], root);

    const buildOutput = await run('npm', ['run', 'build'], root);
    const html = await readFile(path.join(outputDir, 'index.html'), 'utf8');
    assert.ok(html.includes(`/vendor/script-harbor/${artifact.sha256}.js`), `${framework}: actual output HTML should use the hash-addressed local path`);
    assert.ok(html.includes(`integrity="${artifact.sri}"`), `${framework}: actual output HTML should use captured SRI`);
    assert.ok(html.includes('crossorigin="anonymous"'), `${framework}: actual output HTML should use anonymous crossorigin`);
    const vendored = await readFile(path.join(outputDir, 'vendor/script-harbor', `${artifact.sha256}.js`));
    assert.equal(vendored.toString('utf8'), source, `${framework}: vendored source should preserve exact captured bytes`);

    source += `document.body.dataset.changed = 'true';`;
    await assert.rejects(run('npm', ['run', 'build'], root), /Unknown or changed upstream script/);
    process.stdout.write(`${framework}: installed ${dependency}; build hook protected hash ${artifact.sha256}; modified upstream caused the next build to fail closed.\n`);
    return { framework, version: dependency.split('@').at(-1)!, hash: artifact.sha256, output: buildOutput.split('\n').filter((line) => /built in|Complete!|Result/.test(line)).slice(-2).join(' ').trim() };
  } finally {
    await close(upstream).catch(() => undefined);
  }
}

try {
  const tarball = await packageTarball();
  const results = [];
  results.push(await exercise('vite', 'vite@8.3.5', tarball));
  results.push(await exercise('astro', 'astro@7.4.4', tarball));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
