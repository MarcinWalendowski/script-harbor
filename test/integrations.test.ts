import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeManifest } from '../src/store.js';
import type { Manifest } from '../src/types.js';
import { astro, initProject, vite } from '../src/integrations.js';
import { runCli } from '../src/cli.js';

const presets = [
  ['astro', 'dist'], ['vite', 'dist'], ['next', 'out'], ['nuxt', '.output/public'], ['sveltekit', 'build'],
] as const;

test('init preserves the existing build, configures all five static presets, and is idempotent', async () => {
  for (const [framework, output] of presets) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-init-'));
    try {
      const packageFile = path.join(cwd, 'package.json');
      await writeFile(packageFile, JSON.stringify({ name: 'fixture', scripts: { build: 'vite build', test: 'node test.js', 'custom:keep': 'echo keep' } }));
      await initProject({ cwd, framework, origin: 'https://example.test/app' });
      const first = JSON.parse(await readFile(packageFile, 'utf8')) as { scripts: Record<string, string> };
      assert.equal(first.scripts['build:unprotected'], 'vite build');
      assert.equal(first.scripts.build, 'npm run build:unprotected && npm run script-harbor:protect');
      assert.equal(first.scripts['script-harbor:protect'], `script-harbor protect --dir ${output} --origin https://example.test`);
      assert.equal(first.scripts.test, 'node test.js');
      assert.equal(first.scripts['custom:keep'], 'echo keep');
      await initProject({ cwd, framework, origin: 'https://example.test/another-path' });
      const second = JSON.parse(await readFile(packageFile, 'utf8')) as { scripts: Record<string, string> };
      assert.deepEqual(second.scripts, first.scripts);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test('init refuses conflicting helper commands without changing package metadata', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-conflict-'));
  try {
    const packageFile = path.join(cwd, 'package.json');
    const original = { name: 'fixture', scripts: { build: 'custom build', 'build:unprotected': 'different build', 'script-harbor:protect': 'echo unsafe' } };
    await writeFile(packageFile, JSON.stringify(original));
    await assert.rejects(initProject({ cwd, framework: 'vite', origin: 'https://example.test' }), /conflicting script-harbor/);
    assert.deepEqual(JSON.parse(await readFile(packageFile, 'utf8')), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('init rejects shell metacharacters in origin before changing package metadata', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-shell-origin-'));
  try {
    const packageFile = path.join(cwd, 'package.json');
    const original = { name: 'fixture', scripts: { build: 'vite build' } };
    await writeFile(packageFile, JSON.stringify(original));
    await assert.rejects(initProject({ cwd, framework: 'vite', origin: 'https://example.test;id' }), /valid DNS or IPv6 hostname/);
    assert.deepEqual(JSON.parse(await readFile(packageFile, 'utf8')), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('native hooks reject SSR output and CLI rejects unknown flags', async () => {
  const astroIntegration = astro({ origin: 'https://example.test' });
  assert.throws(() => astroIntegration.hooks['astro:config:done']({ config: { output: 'server' } }), /static output only/);
  const vitePlugin = vite({ origin: 'https://example.test' });
  assert.throws(() => vitePlugin.configResolved({ root: '/tmp/site', build: { outDir: 'dist', ssr: 'entry-server.ts' } }), /static client output only/);
  await assert.rejects(runCli(['check', '--unknown']), /Unknown option/);
});

test('installed CLI symlink dispatches commands through the real entrypoint', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'script-harbor-bin-'));
  try {
    const link = path.join(cwd, 'script-harbor');
    await symlink(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), link);
    const child = spawnSync(process.execPath, ['--import', 'tsx', link, 'unknown-command'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /Unknown command "unknown-command"/);

    const stateDir = path.join(cwd, '.script-harbor');
    const manifest: Manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), origins: [], artifacts: [], localScripts: [], coverage: { mode: 'static', pages: [], limitations: [] }, errors: [] };
    await writeManifest(stateDir, manifest);
    const list = spawnSync(process.execPath, ['--import', 'tsx', link, 'list', '--state-dir', stateDir, '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.stdout.trim(), '[]');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
