# Security and threat model

Script Harbor helps teams inventory browser scripts, notice byte changes, review source, and serve explicitly approved bytes from their own static build. It does not prove that code is safe. Heuristics and LLMs can miss malicious behavior, and a human can approve harmful code. A hash proves identity of bytes, not intent.

## Threats in scope

- A third-party URL changes after review, or begins serving a different response.
- A build contains an unknown, incomplete, tampered, or unapproved script source.
- A review is stale because its source, model, prompt, or policy fingerprint changed.
- Malformed or hostile HTML, source text, provider responses, or local state attempts to confuse the scanner or approval flow.
- A script relies on dynamic loaders, module relationships, origin checks, consent state, or other behavior that makes relocation unsafe.

The CLI is designed to fail closed on these detected conditions. Relocation blockers are detection limits: absence of a blocker is not proof that a script works or is safe when self-hosted.

## Out of scope and limits

Script Harbor does not sandbox reviewed code, certify a vendor, inspect every runtime path, or guarantee that a static scan sees scripts created after its input pages are loaded. Runtime capture executes page code in a fresh Playwright context; it is not an OS sandbox. The scanner observes only its inputs and bounded observation window. Dynamic `import()`, computed URLs, service behavior outside the captured window, and descendants not observed can evade inventory. Do not run a suspected incident payload or use runtime scanning with personal browser state or secrets.

Review providers receive script source. Treat that as a data disclosure: check your provider's terms and controls before sending proprietary or sensitive code. API keys are read from environment variables and must be supplied through a secret manager in CI. Script Harbor has no outbound telemetry. Local audit events and reports may contain URLs, findings, or source-related metadata; keep private evidence out of public repositories.

## Trust and approval

- A review is advisory evidence, not approval.
- Approval records a human identity, reason, exact content hash, and review fingerprint. A changed hash or review fingerprint requires a new approval.
- `--allow-rehost` records that the approver explicitly accepted responsibility for rehosting and redistribution. Check vendor terms and origin-sensitive behavior.
- Manifest and approval files are version-controlled trust inputs, not signed attestations. Protect changes through normal code review and branch controls.
- Vendoring preserves the captured response bytes and verifies the hash. It does not make code harmless or preserve all vendor behavior.
- SRI and CSP are useful defense-in-depth controls, but Script Harbor does not silently change your CSP or claim either control solves every loader or browser-policy issue.

## Browser and network boundaries

Static scan fetches scripts but does not execute them. Network fetching is restricted to public HTTP(S) resources with bounded size, timeout and redirects, without ambient credentials or cookies. Local-network access exists only as an explicit test opt-in; do not enable it for ordinary scans.

Runtime scanning should run in an ephemeral CI worker or disposable environment with no personal profile, secrets, authenticated storage, or valuable credentials. It uses a fresh browser context and restricts browser network behavior, but a browser process is not a security boundary against all operating-system or browser vulnerabilities. Never point it at malicious incident code.

## If you find a vulnerability

Do not publish a report containing private source, credentials, or exploitable details. Contact the repository owner through GitHub's private vulnerability reporting feature when enabled, or open a minimal issue asking for a private reporting channel.
