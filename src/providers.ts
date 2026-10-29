import { parseReviewResult, buildPrompt } from './analysis.js';
import type { Provider, ReviewOptions, ReviewResult } from './types.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

interface RequestShape { url: string; headers: Record<string, string>; body: unknown }

function defaultEndpoint(provider: Exclude<Provider, 'external'>): string {
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (provider === 'claude') return 'https://api.anthropic.com/v1/messages';
  return 'https://api.openai.com/v1/responses';
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function validateEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid provider endpoint'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new Error('Provider endpoint must use HTTPS (HTTP is allowed only for loopback tests)');
  }
  return url.toString();
}

function makeRequest(provider: Exclude<Provider, 'external'>, model: string, apiKey: string, system: string, user: string): RequestShape {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: unknown;
  if (provider === 'openrouter') {
    headers.authorization = `Bearer ${apiKey}`;
    body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  } else if (provider === 'claude') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    body = { model, instructions: system, input: user, store: false };
  }
  return { url: defaultEndpoint(provider), headers, body };
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error('Provider returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Provider response exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function extractText(provider: Exclude<Provider, 'external'>, payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('Provider returned a malformed response');
  const data = payload as Record<string, unknown>;
  if (provider === 'openrouter') {
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length !== 1 || !choices[0] || typeof choices[0] !== 'object') throw new Error('Provider returned a malformed response');
    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message;
    if (choice.finish_reason !== 'stop' || !message || typeof message !== 'object') throw new Error('Provider response was incomplete or refused');
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Provider returned no review text');
    return content;
  }
  if (provider === 'claude') {
    if (data.stop_reason !== 'end_turn' || !Array.isArray(data.content) || data.content.length === 0) throw new Error('Provider response was incomplete or refused');
    const blocks = data.content as unknown[];
    if (blocks.some((block) => !block || typeof block !== 'object' || (block as Record<string, unknown>).type !== 'text' || typeof (block as Record<string, unknown>).text !== 'string')) {
      throw new Error('Provider response included a refusal, tool, or non-text block');
    }
    const text = blocks.map((block) => (block as { text: string }).text).join('');
    if (!text.trim()) throw new Error('Provider returned no review text');
    return text;
  }

  if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('Provider response was incomplete or refused');
  const items = data.output as unknown[];
  const messages = items.filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'message');
  if (messages.length !== 1 || items.some(item => !item || typeof item !== 'object' || !['reasoning', 'message'].includes(String((item as Record<string, unknown>).type)))) throw new Error('Provider response included a refusal, tool, or unexpected output');
  const message = messages[0] as Record<string, unknown>;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Provider returned a malformed response');
  const blocks = message.content as unknown[];
  if (blocks.some((block) => !block || typeof block !== 'object' || (block as Record<string, unknown>).type !== 'output_text' || typeof (block as Record<string, unknown>).text !== 'string' || (block as Record<string, unknown>).refusal)) {
    throw new Error('Provider response included a refusal or non-text output');
  }
  const text = blocks.map((block) => (block as { text: string }).text).join('');
  if (!text.trim()) throw new Error('Provider returned no review text');
  return text;
}

function retryableStatus(status: number): boolean { return status === 429 || status >= 500; }

async function waitBeforeRetry(attempt: number): Promise<void> {
  const base = 150 * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 150);
  await new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export async function requestReview(source: string, options: ReviewOptions): Promise<ReviewResult> {
  if (options.provider === 'external') throw new Error('External reviews must be imported, not requested from a provider');
  if (!['openrouter', 'claude', 'codex'].includes(options.provider)) throw new Error('Unsupported review provider');
  if (!options.model.trim()) throw new Error('A provider model is required');
  const prompt = buildPrompt(source, options.maxChars);
  const provider = options.provider as Exclude<Provider, 'external'>;
  const envKey = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : provider === 'claude' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  const apiKey = options.apiKey ?? envKey;
  if (!apiKey) throw new Error(`Missing API key for ${provider}; configure its environment variable`);
  const request = makeRequest(provider, options.model, apiKey, prompt.system, prompt.user);
  request.url = validateEndpoint(options.endpoint ?? request.url);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt + 1 >= MAX_ATTEMPTS) throw new Error('Provider request failed or timed out');
      await waitBeforeRetry(attempt);
      continue;
    }
    if (response.status >= 300 && response.status < 400) throw new Error('Provider redirects are not allowed');
    if (!response.ok) {
      if (retryableStatus(response.status) && attempt + 1 < MAX_ATTEMPTS) {
        await response.body?.cancel();
        await waitBeforeRetry(attempt);
        continue;
      }
      throw new Error(`Provider request failed with HTTP ${response.status}`);
    }
    let payload: unknown;
    try { payload = JSON.parse(await readBounded(response)) as unknown; }
    catch (error) {
      if (error instanceof Error && error.message.includes('size limit')) throw error;
      throw new Error('Provider returned invalid JSON response');
    }
    return parseReviewResult(extractText(provider, payload));
  }
  throw new Error('Provider request failed');
}
