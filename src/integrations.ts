import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Framework = 'astro' | 'vite' | 'next' | 'nuxt' | 'sveltekit';
const outputDirs: Record<Framework, string> = { astro: 'dist', vite: 'dist', next: 'out', nuxt: '.output/public', sveltekit: 'build' };

export async function initProject(options: { cwd?: string; framework: string; origin: string }): Promise<void> {
  if (!(options.framework in outputDirs)) throw new Error('Framework must be astro, vite, next, nuxt, or sveltekit');
  const origin = new URL(options.origin);
  const validHostname = origin.hostname.startsWith('[')
    ? /^\[[0-9a-f:.]+\]$/i.test(origin.hostname)
    : /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(origin.hostname);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || !validHostname) throw new Error('A public HTTP(S) origin with a valid DNS or IPv6 hostname is required');
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packageFile = path.join(cwd, 'package.json');
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(await readFile(packageFile, 'utf8')) as Record<string, unknown>; }
  catch (error) { throw new Error(`Cannot read project package.json at ${packageFile}`, { cause: error }); }
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? { ...pkg.scripts as Record<string, unknown> } : {}) as Record<string, unknown>;
  const currentBuild = scripts.build;
  const unprotected = scripts['build:unprotected'];
  if (currentBuild === undefined && unprotected === undefined) throw new Error('Cannot install build protection without an existing build script');
  if (scripts['script-harbor:protect'] !== undefined && scripts['script-harbor:protect'] !== `script-harbor protect --dir ${outputDirs[options.framework as Framework]} --origin ${origin.origin}`) {
    throw new Error('Refusing to overwrite a conflicting script-harbor:protect command');
  }
  if (currentBuild && scripts.build !== 'npm run build:unprotected && npm run script-harbor:protect') {
    if (unprotected !== undefined && unprotected !== currentBuild) throw new Error('Both build and build:unprotected exist with different commands; resolve the conflict manually');
    if (unprotected === undefined) scripts['build:unprotected'] = currentBuild;
  } else if (currentBuild && unprotected === undefined) {
    throw new Error('build already invokes Script Harbor but build:unprotected is missing');
  }
  if (currentBuild || unprotected) scripts.build = 'npm run build:unprotected && npm run script-harbor:protect';
  scripts['script-harbor:protect'] = `script-harbor protect --dir ${outputDirs[options.framework as Framework]} --origin ${origin.origin}`;
  pkg.scripts = scripts;
  await writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function astro(options: { dir?: string; origin: string }) {
  return {
    name: 'script-harbor',
    hooks: {
      'astro:config:done': ({ config }: { config: { output?: string } }) => {
        if (config.output === 'server') throw new Error('Script Harbor Astro hook supports static output only; configure a public directory explicitly for SSR');
      },
      'astro:build:done': async ({ dir }: { dir: URL }) => {
        const { protect } = await import('./pipeline.js');
        await protect({ dir: options.dir ?? fileURLToPath(dir), origin: options.origin });
      },
    },
  };
}

export function vite(options: { dir?: string; origin: string }) {
  let outputDirectory = path.resolve(options.dir ?? 'dist');
  return {
    name: 'script-harbor',
    apply: 'build' as const,
    enforce: 'post' as const,
    configResolved: (config: { root: string; build: { outDir: string; ssr?: boolean | string } }) => {
      if (config.build.ssr) throw new Error('Script Harbor Vite hook supports static client output only; configure protect for a public directory explicitly');
      outputDirectory = path.resolve(config.root, options.dir ?? config.build.outDir);
    },
    closeBundle: async () => {
      const { protect } = await import('./pipeline.js');
      await protect({ dir: outputDirectory, origin: options.origin });
    },
  };
}
