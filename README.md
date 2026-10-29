# Script Harbor

Script Harbor inventories browser scripts, records their exact bytes and hashes, supports source review, and pins approved bytes to your own static build. It is an audit and change control tool. It cannot certify that a script is safe.

## Why this exists

Script Harbor was created in response to the reported Polymarket frontend compromise and drained funds involving a third-party DebugBear import. On October 29, 2026, [DebugBear confirmed an ongoing security incident and asked RUM customers to remove its embed](https://x.com/DebugBear/status/2115866496643535293). The Polymarket impact and wallet-drain account come from the incident report shared by this project's author; DebugBear's linked statement does not itself confirm those details.

A browser script runs with the privileges of the page that loads it. A vendor URL can serve different bytes after your review, and third-party code may read page data, interact with wallet providers, or load more code. Script Harbor helps you see and control byte changes. A review, hash, approval, SRI value, or self-hosted copy is not a guarantee against malicious or compromised code.

## Quick start

Requires Node.js 22.22 or newer. Install in your website repository and inject a build hook:

```sh
npm install --save-dev github:MarcinWalendowski/script-harbor
npx script-harbor init --framework astro --origin https://www.example.com
```

Or build a local package:

```sh
git clone https://github.com/MarcinWalendowski/script-harbor.git
cd script-harbor
npm ci
npm run build
npm pack
```

Install the resulting local tarball in the website repository (the package is not yet published to npm):

```sh
npm install --save-dev ../script-harbor/marcinwalendowski-script-harbor-0.1.0.tgz
npx script-harbor init --framework vite --origin https://www.example.com
```

`init` configures the static build hook for the chosen framework. Capture the actual build you intend to deploy (or use `scan --url https://www.example.com` to inventory a production page):

```sh
npm run build:unprotected
npx script-harbor scan --dir dist --origin https://www.example.com
npx script-harbor list
npx script-harbor review --provider openrouter --model YOUR_MODEL
npx script-harbor approve SHA256 --reviewer "Your Name" --reason "Reviewed for production use" --allow-rehost
```

Set `OPENROUTER_API_KEY` in your shell or CI secret store before a provider review. Other providers are `claude` (Anthropic API) and `codex` (OpenAI Responses API); their keys are `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. The `codex` provider is an API integration, not a Codex subscription or CLI login. Review requests do not have tools and never approve automatically. Inspect the findings and source yourself before using `approve`.

Check a built bundle or run the configured protection step:

```sh
npx script-harbor check
npm run build
```

`protect` fails the build when an artifact is unknown, changed, unapproved, incomplete, or has a detected relocation blocker. It writes the approved captured bytes under the site's public output and rewrites matching tags with SRI. Preserve `.script-harbor/manifest.json`, `approvals.json`, and the matching source and review files in the website repository so CI can verify the same content offline. Keep private reports and credentials out of public repositories.

Unchanged content reuses its review by SHA-256, provider, model, prompt version, and policy version. The build still checks integrity. `check` works offline; `check --live` also detects upstream drift. Reports are saved as JSON and Markdown under `.script-harbor/`.

## Review with another LLM

Use Claude Code, Codex CLI, or any other LLM through the interchange format:

```sh
npx script-harbor export-review --hash SHA256 --out request.json
# Give request.json to your reviewer; save its ReviewResult JSON as response.json.
npx script-harbor import-review --hash SHA256 --model REVIEWER_LABEL --file response.json
```

Import validates the result; approval remains a separate command. The direct `review` command also accepts `SCRIPT_HARBOR_PROVIDER` and `SCRIPT_HARBOR_MODEL` defaults.

See [integrations](docs/integrations.md) for providers, export/import and host deployment setup, and [verification](docs/verification.md) for what the checks do and do not establish.

## Scope and limits

Static scans inspect the provided pages and markup; they do not execute fetched scripts. Optional `--runtime` capture observes responses in a fresh disposable Playwright context, but executing third-party code is risky and browser capture is not OS isolation. Do not use a personal browser profile, secrets, or incident payloads. Both modes have bounded coverage and may miss dynamically constructed loaders or behavior outside the observation window.

Large applications can explicitly raise the default 100-script and 200-request budgets with `scan --max-scripts 500 --max-requests 1500`. The maximum overrides are 1,000 scripts and 2,000 runtime requests; the 50 MiB runtime response budget remains enforced. Any capture failure keeps the report incomplete and blocks approval and protection. Runtime-only third-party loaders require source changes and a new scan before automatic static protection.

Script Harbor supports static output from Astro, Vite, Next.js, Nuxt and SvelteKit. Vercel, Netlify, Cloudflare Pages, GitHub Pages and generic CDNs can use the same build command. Server-rendered deployments need explicit manual vendoring and source mapping; transparent SSR rewriting is not provided. The tool does not deploy your website, publish a package, or modify CSP policy. See [security and threat model](SECURITY.md).

## Development

```sh
npm run typecheck
npm run lint
npx playwright install chromium
npm test
npm run build
npm run test:e2e
npm run test:package
```

## License

MIT. See [LICENSE](LICENSE).
