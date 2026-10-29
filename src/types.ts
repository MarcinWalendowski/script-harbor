export const PROMPT_VERSION = '1';
export const POLICY_VERSION = '1';
export type Provider = 'openrouter' | 'claude' | 'codex' | 'external';
export interface Artifact {
  url: string; finalUrl: string; sha256: string; sri: string; bytes: number;
  contentType: string; pages: string[]; kind: 'classic' | 'module' | 'preload' | 'runtime';
  thirdParty: boolean; relocation: 'eligible' | 'manual'; relocationReasons: string[];
}
export interface Manifest {
  schemaVersion: 1; createdAt: string; origins: string[]; artifacts: Artifact[];
  localScripts: string[];
  coverage: { mode: 'static' | 'runtime'; pages: string[]; limitations: string[] };
  errors: string[];
}
export interface Finding { severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; category: string; evidence: string; explanation: string }
export interface ReviewResult {
  verdict: 'low-risk' | 'review-required' | 'high-risk'; summary: string;
  findings: Finding[]; relocation: {safe: boolean; reason: string};
}
export interface Review extends ReviewResult {
  schemaVersion: 1; fingerprint: string; sha256: string; provider: Provider; model: string;
  promptVersion: string; policyVersion: string; createdAt: string;
}
export interface Approval { sha256: string; fingerprint: string; urls: string[]; reviewer: string; reason: string; approvedAt: string; allowRehost: boolean }
export interface FetchOptions { allowLocal?: boolean; maxBytes?: number; timeoutMs?: number; maxRedirects?: number }
export interface FetchResult { url: string; finalUrl: string; body: Buffer; contentType: string; status: number }
export interface ScanOptions extends FetchOptions { urls?: string[]; dir?: string; origin?: string; stateDir?: string; runtime?: boolean; observeMs?: number; maxScripts?: number; maxRequests?: number }
export interface ReviewOptions { provider: Provider; model: string; stateDir?: string; maxChars?: number; apiKey?: string; endpoint?: string }
export interface ProtectOptions extends ScanOptions { publicPath?: string; provider?: Provider; model?: string }
export interface ScriptReference { url: string; kind: Artifact['kind']; start: number; end: number; tag: string; attributes: Record<string,string> }
