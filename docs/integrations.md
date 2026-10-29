# Integrations

Script Harbor is a CLI and build-time check. It does not require a hosted control plane and does not deploy a consuming website.

## Frameworks

`init --framework <name> --origin <production-origin>` supports `astro`, `vite`, `next`, `nuxt`, and `sveltekit`. It wraps the existing build command as `build:unprotected`, then runs protection over the framework's static output. The command is intended for static builds; Next.js, Nuxt and SvelteKit require their static-export / prerender configuration. Review the generated package scripts and output directory in your project before relying on them.

If you already manage scripts explicitly, run the CLI directly after your static build:

```sh
npx script-harbor protect --dir dist --origin https://www.example.com
```

| Preset | Build output inspected | Required application mode |
| --- | --- | --- |
| `astro` | `dist` | Static output |
| `vite` | `dist` | Client/SPA build |
| `next` | `out` | `output: 'export'` |
| `nuxt` | `.output/public` | `nuxt generate` |
| `sveltekit` | `build` | `@sveltejs/adapter-static` |

Custom output directories can change the generated `script-harbor:protect` script. These are five supported presets, not a market-share ranking. Native Astro and Vite hooks are also exported from `@marcinwalendowski/script-harbor/integrations`; choose the hook or the package-script wrapper, not both.

The configured origin is used to map production page URLs to built HTML and resolve script references. Keep the origin aligned with the deployed site.

## Hosting and CI

Vercel, Netlify, Cloudflare Pages, GitHub Pages, and a generic static CDN can run the same protection command as the final build step. Configure the host's build command to complete the framework build and then run `script-harbor protect` against the actual output directory. Do not assume a platform-specific integration is installed merely because its build environment supports Node.

The CLI needs no provider secret for offline `check` or protection when reviewed state is already present. If CI performs a provider review, provide only the chosen provider API key through the host's secret settings. Do not put credentials in command-line arguments or committed config.

After `init`, use `npm run build` as the build command in Vercel, Netlify or Cloudflare Pages and keep the host's output-directory setting aligned with the table. GitHub Pages and generic CDN jobs should upload the resulting protected directory only after that command succeeds. No host-specific control-plane credentials are needed by Script Harbor.

A reusable GitHub Action verifies committed state offline:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: '24'
  - uses: MarcinWalendowski/script-harbor@main # pin a reviewed commit in production
    with:
      state-dir: .script-harbor
```

This action does not discover newly introduced tags. Run the protected production build too. CI caches are only an optimization; commit the reviewed source and approvals rather than treating an untrusted cache as an approval record.

## Review providers

Direct provider integrations send the full script source to a tool-free request:

| Provider flag | API | Environment variable |
| --- | --- | --- |
| `openrouter` | OpenRouter chat completions | `OPENROUTER_API_KEY` |
| `claude` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `codex` | OpenAI Responses API | `OPENAI_API_KEY` |

Pass `--model` explicitly or configure the documented default. Provider output is schema-validated and recorded against the content hash, provider, model, prompt version, and policy version. Refusals, incomplete responses, or invalid output fail review. These are APIs paid and authenticated separately from consumer subscriptions: `codex` does not use Codex CLI login or subscription credentials. A provider response is never an approval.

The default full-source review limit is 200,000 characters. If an artifact is larger, direct review fails instead of truncating it. You may raise `--max-chars` up to 5 MiB only when the selected model and provider accept the full input; otherwise use the external export/import flow with a reviewer that can handle it. Never treat a partial-source review as a review of the captured artifact.

## External review export/import

`export-review` emits a JSON packet containing the review instructions and complete source text for the selected hash. Send it to an external reviewer only if your data policy permits that disclosure. The expected response is the `ReviewResult` JSON shape: `verdict`, `summary`, `findings` (each with `severity`, `category`, `evidence`, `explanation`), and `relocation` (`safe`, `reason`). It must not contain trusted hashes, approvals, file paths, or commands.

`import-review` validates the packet and stores it as an external review bound to the selected hash. Importing does not approve or vendor. Inspect the result and use the regular human `approve` command to record a decision. The export format is an interchange format, not a signature or proof of who authored the response.

## Server-rendered applications

There is no transparent SSR rewrite hook. For server-rendered applications, manually vendor approved bytes into the public directory with `vendor --public-dir public`, and explicitly map server-rendered tags to the resulting public paths in your application. Verify all server templates and runtime-generated HTML yourself. A successful static build check does not establish that SSR output is protected.

For your own CDN, upload the exact vendored files under their content-addressed names and use the generated SRI values in your application. Automatic CDN uploads, bundler import rewriting, and automatic patching of SSR templates are outside this release.

## Review renewal and revocation

Remove a hash's entry from `approvals.json` to revoke it. A changed source hash, provider/model selection, prompt version, or policy version requires a matching new review and approval. Use versioned model identifiers when the provider offers them. Imported reviews cannot overwrite an existing fingerprint; use a new reviewer/model label for a new assessment. Approval also binds the captured URLs, so a new URL with identical bytes reuses analysis but needs an explicit approval.
