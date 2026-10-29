import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from './types.js';
import { analyzeSource } from './analysis.js';
import { atomicWrite, hashBytes, readAllReviews, readApprovals, readSource } from './store.js';

function md(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/[\r\n]+/g, ' ');
}

export async function writeReport(stateDir: string, manifest: Manifest): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const [reviews, approvals] = await Promise.all([readAllReviews(stateDir), readApprovals(stateDir)]);
  const staticHints = new Map<string, ReturnType<typeof analyzeSource>>();
  for (const artifact of manifest.artifacts) {
    const bytes = await readSource(stateDir, artifact.sha256);
    const hashes = hashBytes(bytes);
    if (bytes.byteLength !== artifact.bytes || hashes.sri !== artifact.sri) throw new Error(`Cannot report unverified source bytes for ${artifact.url}`);
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`Cannot report invalid UTF-8 source for ${artifact.url}`); }
    staticHints.set(`${artifact.url}\0${artifact.sha256}`, analyzeSource(source));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    coverage: manifest.coverage,
    origins: manifest.origins,
    errors: manifest.errors,
    artifacts: manifest.artifacts.map((artifact) => {
      const artifactReviews = reviews.filter((review) => review.sha256 === artifact.sha256);
      return {
        ...artifact,
        staticHints: { classification: 'heuristic hints only; not a verdict or proof of safety', findings: staticHints.get(`${artifact.url}\0${artifact.sha256}`) ?? [] },
        reviews: artifactReviews,
        approvals: approvals.filter((approval) => approval.sha256 === artifact.sha256 && approval.urls.includes(artifact.url) && artifactReviews.some((review) => review.fingerprint === approval.fingerprint)),
      };
    }),
    localScripts: manifest.localScripts,
  };
  const lines = [
    '# Script Harbor audit report',
    '',
    `Generated: ${md(report.generatedAt)}`,
    `Coverage mode: ${md(manifest.coverage.mode)}`,
    `Pages observed: ${manifest.coverage.pages.length}`,
    '',
    '## Coverage limits',
    '',
    ...(manifest.coverage.limitations.length ? manifest.coverage.limitations.map((item) => `- ${md(item)}`) : ['- None recorded.']),
    '',
    '## Capture errors',
    '',
    ...(manifest.errors.length ? manifest.errors.map((item) => `- ${md(item)}`) : ['- None.']),
    '',
    '## Artifacts',
    '',
    '| URL | SHA-256 | Bytes | Review | Approval | Relocation |',
    '| --- | --- | ---: | --- | --- | --- |',
    ...(report.artifacts.length ? report.artifacts.map((artifact) => {
      const approval = artifact.approvals.length > 0;
      const status = artifact.reviews.length ? artifact.reviews.map((review) => `${review.provider}/${review.model}: ${review.verdict}`).join(', ') : 'not reviewed';
      return `| ${md(artifact.url)} | ${artifact.sha256} | ${artifact.bytes} | ${md(status)} | ${approval ? 'approved' : 'not approved'} | ${md(artifact.relocation)} |`;
    }) : ['| _None_ | — | — | — | — | — |']),
    '',
    '## Static capability hints',
    '',
    'These narrow pattern matches can miss behavior and do not determine the review verdict.',
    '',
    ...(report.artifacts.length ? report.artifacts.flatMap((artifact) => [
      `### ${md(artifact.url)}`,
      '',
      ...(artifact.staticHints.findings.length ? artifact.staticHints.findings.map((finding) => `- **${md(finding.severity)} ${md(finding.category)}:** evidence \`${md(finding.evidence)}\` — ${md(finding.explanation)}`) : ['- No static capability pattern matched; this is not evidence of safety.']),
      '',
    ]) : ['No artifacts were captured.', '']),
    '',
    'Reviews are evidence, not proof of safety. Human approvals authorize only the exact source hash and review fingerprint.',
    '',
  ];
  await atomicWrite(path.join(stateDir, 'report.json'), `${JSON.stringify(report, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}\n`);
  await atomicWrite(path.join(stateDir, 'report.md'), lines.join('\n'));
}
