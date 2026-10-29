import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), 'harbor-package-'));
const source = 'document.documentElement.dataset.harbor = "pinned";';
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/javascript' }).end(source));
try {
  await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd: root });
  const consumer = path.join(scratch, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'smoke-consumer', private: true, scripts: { build: 'node -e "console.log(\'build executed\')"' } }));
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(scratch, 'marcinwalendowski-script-harbor-0.1.0.tgz')], { cwd: consumer });
  const bin = path.join(consumer, 'node_modules', '.bin', 'script-harbor');
  const run = (...args: string[]) => exec(bin, args, { cwd: consumer });
  assert.match((await run('--help')).stdout, /Workflow:/);
  await assert.rejects(run('nonexistent-command'));
  await assert.rejects(run('check'));
  await run('init', '--framework', 'vite', '--origin', 'https://smoke.example');
  await assert.rejects(exec('npm', ['run', 'build'], { cwd: consumer }), 'npm build must propagate missing-approval failure through its installed bin');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/script.js`;
  await mkdir(path.join(consumer, 'dist'));
  await writeFile(path.join(consumer, 'dist/index.html'), `<script src="${url}"></script>`);
  await run('scan', '--dir', 'dist', '--origin', 'https://smoke.example', '--allow-local');
  const list = JSON.parse((await run('list', '--json')).stdout) as Array<{sha256:string}>;
  const hash = list[0]!.sha256;
  await run('export-review', '--hash', hash, '--out', 'prompt.json');
  assert.ok((await readFile(path.join(consumer, 'prompt.json'), 'utf8')).includes('pinned'));
  await writeFile(path.join(consumer, 'review.json'), JSON.stringify({ verdict: 'low-risk', summary: 'Deterministic package fixture', findings: [], relocation: { safe: true, reason: 'Writes a constant DOM data attribute only.' } }));
  await run('import-review', '--hash', hash, '--model', 'package-fixture', '--file', 'review.json');
  await run('approve', hash, '--reviewer', 'Package test', '--reason', 'Synthetic fixture', '--allow-rehost');
  await run('protect', '--dir', 'dist', '--origin', 'https://smoke.example', '--allow-local');
  await run('check');
  assert.equal(await readFile(path.join(consumer, 'dist/vendor/script-harbor', `${hash}.js`), 'utf8'), source);
  process.stdout.write('Installed package: help, invalid-command failure, npm build failure propagation, capture/list/export/import/approval/protect/check all passed.\n');
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
}
