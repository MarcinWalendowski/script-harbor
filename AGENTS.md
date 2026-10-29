# Script Harbor

Use `.ai/specs/SPEC-script-harbor-audit-hook.md` as the implementation contract. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:e2e` before shipping. Never execute captured third-party source outside an explicitly requested disposable browser scan. Never conflate an LLM review, human approval, and proof of safety. Preserve exact vendored bytes. Secrets belong only in environment variables. Do not commit downloaded vendor code, credentials, or private audit reports into this public tool repository.

This is a standalone repository. Its spec uses a descriptive identifier; no shared numeric spec allocation. Follow the workspace's spec/advisor/delegation and one-feature-commit rules. GitHub Actions and package publication are separate from deployment of a consuming website.
