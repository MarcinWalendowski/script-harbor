#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { approve, check, exportReviewInput, importReviewResult, protect, review, scan, vendor } from './pipeline.js';
import { initProject } from './integrations.js';
import { readManifest } from './store.js';
import type { Provider } from './types.js';

const help = `Script Harbor — inventory, review, approve and pin browser scripts

Workflow:
  1. Scan production URLs or built HTML to capture exact source bytes.
  2. Review each captured hash with an LLM, or export/import an external review.
  3. A human explicitly approves the hash and whether it may be rehosted.
  4. Protect freshly built static output. Unknown, changed, unapproved, or
     non-relocatable scripts fail the build before HTML is rewritten.
  5. Run check in CI to verify the committed manifest, source bytes, reviews,
     approvals and current review policy. Use --live to also fetch upstream.

Commands:
  scan --url URL [--url URL ...] [--runtime] [--max-scripts N] [--max-requests N] [--allow-local]
  scan --dir DIR --origin URL
  review --provider openrouter|claude|codex --model MODEL [--max-chars N]
  approve HASH --reviewer NAME --reason TEXT [--allow-rehost] [--fingerprint HASH]
  check [--provider PROVIDER --model MODEL] [--live] [--allow-local]
  vendor --public-dir DIR [--public-path PATH]
  protect --dir DIR --origin URL [--public-path PATH] [--provider PROVIDER --model MODEL]
  init --framework astro|vite|next|nuxt|sveltekit --origin URL [--cwd DIR]
  list [--json]
  export-review --hash SHA256 [--out FILE] [--max-chars N]
  import-review --hash SHA256 --model LABEL --file FILE

External review: export-review includes the source-bound prompt and schema.
Submit its user/system content to your chosen model, then import only the model's
strict ReviewResult JSON. Hash, provider=external, model, prompt/policy versions
and timestamps are generated or selected locally; imported model output cannot
set identities, paths, hashes, approvals or commands.

Review is evidence, not a safety certificate. Dynamic loaders and origin-sensitive
code require manual handling and are never automatically rehosted. --allow-local
is an explicit loopback-only opt-in for local fixtures; reports record it.
Review provider and model can default from SCRIPT_HARBOR_PROVIDER and SCRIPT_HARBOR_MODEL.
Scan limits default to 100 scripts and 200 runtime requests; --max-scripts accepts 1–1000 and --max-requests accepts 1–2000.
`;

type Values = Record<string, string | boolean | string[]>;
function parse(argv: string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>, positional = false): { values: Values; positionals: string[] } {
  const parsed = parseArgs({ args: argv, options: { ...options, 'state-dir': { type: 'string' } }, allowPositionals: positional, strict: true, allowNegative: false });
  return { values: parsed.values as Values, positionals: parsed.positionals };
}
function string(values: Values, key: string, required = false): string | undefined {
  const value = values[key];
  if (value === undefined && required) throw new Error(`--${key} is required`);
  if (typeof value !== 'string') return undefined;
  return value;
}
function provider(values: Values, required = false, allowExternal = false): Provider | undefined {
  const value = string(values, 'provider') ?? process.env.SCRIPT_HARBOR_PROVIDER;
  if (value === undefined && required) throw new Error('--provider is required (or set SCRIPT_HARBOR_PROVIDER)');
  if (value === undefined) return undefined;
  if (!['openrouter', 'claude', 'codex', ...(allowExternal ? ['external'] : [])].includes(value)) throw new Error(`--provider must be ${allowExternal ? 'openrouter, claude, codex, or external' : 'openrouter, claude, or codex'}`);
  return value as Provider;
}
function state(values: Values): string | undefined { return string(values, 'state-dir'); }
function model(values: Values, required = false): string | undefined {
  const value = string(values, 'model') ?? process.env.SCRIPT_HARBOR_MODEL;
  if (!value && required) throw new Error('--model is required (or set SCRIPT_HARBOR_MODEL)');
  return value;
}
function terminalSafe(value: string): string {
  return value.replace(/\p{Cc}/gu, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
function integer(values: Values, key: string, minimum: number, maximum?: number): number | undefined {
  const value = string(values, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) throw new Error(`--${key} must be an integer from ${minimum} through ${maximum ?? 'infinity'}`);
  return parsed;
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  const common = { 'state-dir': { type: 'string' as const } };
  if (command === 'scan') {
    const { values } = parse(args, { ...common, url: { type: 'string', multiple: true }, dir: { type: 'string' }, origin: { type: 'string' }, runtime: { type: 'boolean' }, 'allow-local': { type: 'boolean' }, 'observe-ms': { type: 'string' }, 'max-scripts': { type: 'string' }, 'max-requests': { type: 'string' } });
    const urls = values.url as string[] | undefined;
    if (!urls?.length && !string(values, 'dir')) throw new Error('scan requires at least one --url or --dir');
    const result = await scan({ urls, dir: string(values, 'dir'), origin: string(values, 'origin'), stateDir: state(values), runtime: values.runtime === true, allowLocal: values['allow-local'] === true, observeMs: integer(values, 'observe-ms', 0), maxScripts: integer(values, 'max-scripts', 1, 1000), maxRequests: integer(values, 'max-requests', 1, 2000) });
    process.stdout.write(`Captured ${result.artifacts.length} artifact(s); report: ${state(values) ?? '.script-harbor'}/report.md\n`);
    return;
  }
  if (command === 'review') {
    const { values } = parse(args, { ...common, provider: { type: 'string' }, model: { type: 'string' }, 'max-chars': { type: 'string' } });
    const results = await review({ provider: provider(values, true)!, model: model(values, true)!, stateDir: state(values), maxChars: integer(values, 'max-chars', 1) });
    process.stdout.write(`Reviewed ${results.length} artifact(s); report: ${state(values) ?? '.script-harbor'}/report.md\n`);
    return;
  }
  if (command === 'approve') {
    const { values, positionals } = parse(args, { ...common, reviewer: { type: 'string' }, reason: { type: 'string' }, 'allow-rehost': { type: 'boolean' }, fingerprint: { type: 'string' } }, true);
    if (positionals.length !== 1) throw new Error('approve requires exactly one positional HASH');
    const result = await approve(positionals[0]!, { stateDir: state(values), reviewer: string(values, 'reviewer', true)!, reason: string(values, 'reason', true)!, allowRehost: values['allow-rehost'] === true, fingerprint: string(values, 'fingerprint') });
    process.stdout.write(`Approved ${result.sha256} for ${result.urls.length} URL(s); rehosting ${result.allowRehost ? 'allowed' : 'not allowed'}.\n`);
    return;
  }
  if (command === 'check') {
    const { values } = parse(args, { ...common, provider: { type: 'string' }, model: { type: 'string' }, live: { type: 'boolean' }, 'allow-local': { type: 'boolean' } });
    const selectedProvider = provider(values, false, true);
    const selectedModel = model(values);
    await check({ stateDir: state(values), provider: selectedProvider, model: selectedModel, live: values.live === true, allowLocal: values['allow-local'] === true });
    process.stdout.write(`Check passed${values.live === true ? ' (including upstream fetch)' : ''}.\n`);
    return;
  }
  if (command === 'vendor') {
    const { values } = parse(args, { ...common, 'public-dir': { type: 'string' }, 'public-path': { type: 'string' } });
    const mapping = await vendor({ stateDir: state(values), publicDir: string(values, 'public-dir', true)!, publicPath: string(values, 'public-path') });
    process.stdout.write(`Vendored ${Object.keys(mapping).length} artifact(s).\n`);
    return;
  }
  if (command === 'protect') {
    const { values } = parse(args, { ...common, dir: { type: 'string' }, origin: { type: 'string' }, 'public-path': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, 'allow-local': { type: 'boolean' } });
    const result = await protect({ stateDir: state(values), dir: string(values, 'dir', true), origin: string(values, 'origin', true), publicPath: string(values, 'public-path'), provider: provider(values, false, true), model: model(values), allowLocal: values['allow-local'] === true });
    process.stdout.write(`Protected output with ${result.artifacts.length} artifact(s).\n`);
    return;
  }
  if (command === 'init') {
    const { values } = parse(args, { cwd: { type: 'string' }, framework: { type: 'string' }, origin: { type: 'string' } });
    await initProject({ cwd: string(values, 'cwd'), framework: string(values, 'framework', true)!, origin: string(values, 'origin', true)! });
    process.stdout.write('If Script Harbor is not already installed in this project, add it before building: npm install --save-dev github:MarcinWalendowski/script-harbor\n');
    return;
  }
  if (command === 'list') {
    const { values } = parse(args, { ...common, json: { type: 'boolean' } });
    const manifest = await readManifest(state(values) ?? '.script-harbor');
    const rows = manifest.artifacts.map((artifact) => ({ sha256: artifact.sha256, url: artifact.url, bytes: artifact.bytes, relocation: artifact.relocation }));
    if (values.json === true) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else {
      process.stdout.write('SHA-256\tBYTES\tRELOCATION\tURL\n');
      for (const row of rows) process.stdout.write(`${row.sha256}\t${row.bytes}\t${row.relocation}\t${terminalSafe(row.url)}\n`);
    }
    return;
  }
  if (command === 'export-review') {
    const { values } = parse(args, { ...common, hash: { type: 'string' }, out: { type: 'string' }, 'max-chars': { type: 'string' } });
    const bundle = await exportReviewInput({ stateDir: state(values), hash: string(values, 'hash', true)!, maxChars: integer(values, 'max-chars', 1) });
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    const out = string(values, 'out');
    if (out) await writeFile(out, serialized, { flag: 'wx', mode: 0o600 }); else process.stdout.write(serialized);
    return;
  }
  if (command === 'import-review') {
    const { values } = parse(args, { ...common, hash: { type: 'string' }, model: { type: 'string' }, file: { type: 'string' } });
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(string(values, 'file', true)!, 'utf8')) as unknown; }
    catch (error) { throw new Error('Review file is not valid JSON', { cause: error }); }
    await importReviewResult({ stateDir: state(values), hash: string(values, 'hash', true)!, model: string(values, 'model', true)!, result: parsed }); return;
  }
  throw new Error(`Unknown command "${command}". Run script-harbor --help.`);
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`script-harbor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
