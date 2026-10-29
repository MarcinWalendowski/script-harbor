# Verification guide

Script Harbor has several separate verification paths. Keep their results distinct in CI and release notes; success in one does not imply success in another.

## Local project gates

Run the repository checks:

```sh
npm run typecheck
npm run lint
npx playwright install chromium
npm test
npm run build
npm run test:e2e
```

The unit/integration suite exercises parsing, source hashing and tamper rejection, network boundaries, provider response validation, approval binding, and rewriting. The runtime E2E uses local servers and a browser to exercise the capture-to-protect path. Neither suite certifies arbitrary third-party source.

## Live vendor capture

Run `npx tsx scripts/live-vendors.ts` to statically fetch the pinned public Sentry, Google Tag Manager, and Microsoft Clarity examples. The script records capture time, requested and final URL, HTTP status, content type, byte count, and SHA-256 under ignored `artifacts/live-vendors/`. It does not execute vendor code, call an LLM, approve sources, or assert that a vendor's script is safe. URLs or vendor responses can change; inspect each run's metadata and failures.

### Captured example: 2026-10-29 19:03 UTC

All three scanner captures and metadata rechecks returned HTTP 200; requested and final URLs matched. The script performs separate requests for the scanner manifest and the status-bearing metadata record. The capture metadata is retained locally under `artifacts/live-vendors/` and excluded from Git. GTM and Clarity returned different bytes across the two requests; both hashes are shown to make that observation explicit.

| Vendor | Bytes | HTTP | Metadata capture SHA-256 | Scanner SHA-256 |
| --- | ---: | ---: | --- | --- |
| Sentry browser bundle 11.10.0 | 158,404 | 200 | `3638aa589d63f334bf0fc4b20d2e50398830eebbd7abf0418c0544cb0f90fb10` | `3638aa589d63f334bf0fc4b20d2e50398830eebbd7abf0418c0544cb0f90fb10` |
| Google Tag Manager `GTM-MPHTW35` | 527,209 | 200 | `02b511c6a9552332dfb1e595a5e8333cf2429d9cbd2f25fdccce5436aa8e11dc` | `c9baaf8237c4b10924124739150d5f1518d2e6cfe3bfb7f142af308b8d8e7a62` |
| Microsoft Clarity `3t0wlogvdz` | 882 | 200 | `607ff2ea61e2f8f11a91fd0f1f95b8fd4848bd962fb4ecb89f8c165bf1839892` | `6730060a245961d29743eb43d403692dec9c9ce112c7413f1c042ec720e74dc2` |

These are capture identifiers from that run, not endorsements, safety findings, or future expected hashes.

## Executed E2E evidence

`npm run test:e2e` passed on Node.js v24.21.0. The test used local page, script, provider, and app servers; verified private-network fetch rejection without the explicit test opt-in, fail-closed behavior before review, cached mock review, human approval, protected HTML with updated SRI, repeated protection, upstream drift detection, tampered-source rejection, and visible script effect from the local content-addressed path after the upstream servers were shut down. Chromium screenshot and video were generated under ignored `artifacts/e2e/<run>/` and the screenshot was inspected. No external vendor code or API key was used.

## Framework build smoke

Measured 2026-10-29 19:11 UTC with Node.js v24.21.0 using a freshly packed local Script Harbor tarball. `scripts/framework-smoke.ts` installed each framework in an isolated temporary project with `npm install --ignore-scripts`, ran `init`, built actual static output, reviewed and approved a harmless local fixture script, then ran the generated framework build hook. Both built HTML pages referenced the exact locally vendored source hash with matching SRI and `crossorigin="anonymous"`. Changing the fixture server's bytes made the next real framework build fail with the unknown/changed upstream gate.

| Framework | Version | Static build result | Captured fixture SHA-256 | Changed-source build |
| --- | --- | --- | --- | --- |
| Vite | 8.3.5 | Pass, built in 16 ms | `b4172917882d8d9607b24f4ac95de6b10071ba940d46a41f9c13d4a89a0eb2a0` | Failed closed as expected |
| Astro | 7.4.4 | Pass, one page built in 111 ms | `6aa565341b53d475e0da544257fda05eddc41a5067ae3f9126f5680ad7fadac8` | Failed closed as expected |

The projects, installed dependencies, tarball, and captured local fixture bytes were removed after the run. No vendor or external script was used.

## Real SSR application audit

On 2026-10-29, an isolated production build of an existing Next.js application was run locally and inspected in its workspace browser. Static capture found 103 same-origin script URLs and no external script tags. A 10-second runtime scan captured 149 runtime script URLs, including 15 external scripts absent from the initial HTML. Combined static/runtime records covered 150 distinct URLs. The run used explicit budgets of 500 scripts and 1,500 requests.

The scan saved an incomplete report with 13 errors from unavailable local backend services and external telemetry/authentication endpoints. `check` and `protect` both exited 1; the production HTML snapshot remained byte-identical. No captured third-party script was approved or rehosted. Private source, configuration, identifiers, screenshots and captures are kept outside this repository.

This audit produced regression fixes for explicit large-app budget overrides, blank/srcdoc iframe attribution, and retention of runtime-only script evidence during static protection. It does not establish complete discovery or transparent SSR protection.

## Provider and model checks

Provider protocol tests use controlled responses and injected test keys/endpoints. They check request shape and failure handling, not live provider availability, billing, or the quality of a real model's review. A live model request is optional and must be reported separately; it sends the complete source to the provider. Do not claim that a mock test is a live API pass.

## Coverage limits

Static mode inspects supplied HTML/pages and does not execute fetched JavaScript. Runtime mode observes only the configured pages and bounded browser window. No test establishes complete script discovery, absence of malicious behavior, legality of redistribution, compatibility after rehosting, or resistance to browser/OS compromise. Hash and SRI assertions establish byte identity, not safety.

## External LLM interchange test

The active Codex session read the complete 882-byte Clarity bootstrap with SHA-256 `40e353d2a35dfc84990af1d567ad602e1ebdd4d21ab37aed9042351e5c6ba514`, exported its request, and imported a schema-valid external review. The result was `review-required`, relocation unsafe: the bootstrap loads a further script from `scripts.clarity.ms`. No approval was granted. This exercises real external review interchange; the paid HTTP provider adapters were verified by protocol tests, not live paid API calls.
