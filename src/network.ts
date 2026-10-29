import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import type { FetchOptions, FetchResult } from './types.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function isAllowedAddress(address: string, allowLocal: boolean): boolean {
  if (isPublicAddress(address)) return true;
  if (!allowLocal) return false;
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === 'loopback';
  } catch {
    return false;
  }
}

function checkedUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  return url;
}

function decodeStream(response: NodeJS.ReadableStream, encodingHeader: string | undefined): NodeJS.ReadableStream {
  const encoding = (encodingHeader ?? 'identity').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return response;
  if (encoding.includes(',')) throw new Error(`Unsupported content encoding: ${encoding}`);
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  throw new Error(`Unsupported content encoding: ${encoding}`);
}

async function collectBody(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        const error = new Error(`Response exceeds ${maxBytes} decoded bytes`);
        (stream as NodeJS.ReadableStream & { destroy?: (error: Error) => void }).destroy?.(error);
        reject(error);
      } else chunks.push(buffer);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks, size)));
  });
}

interface HopResponse { status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }

async function requestHop(url: URL, options: { allowLocal: boolean; maxBytes: number; deadline: number }): Promise<HopResponse> {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  let pinnedAddress: string;
  let family: number;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    pinnedAddress = hostname;
    family = literalFamily;
  } else {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error('Request deadline exceeded during DNS lookup');
    let dnsTimer: NodeJS.Timeout | undefined;
    let answers: LookupAddress[];
    try {
      answers = await Promise.race([
        dnsLookup(hostname, { all: true, verbatim: true }) as Promise<LookupAddress[]>,
        new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('Request deadline exceeded during DNS lookup')), remaining); }),
      ]);
    } finally {
      if (dnsTimer) clearTimeout(dnsTimer);
    }
    if (answers.length === 0) throw new Error(`DNS returned no addresses for ${hostname}`);
    for (const answer of answers) {
      if (!isAllowedAddress(answer.address, options.allowLocal)) throw new Error(`Blocked non-public address for ${hostname}: ${answer.address}`);
    }
    pinnedAddress = answers[0]!.address;
    family = answers[0]!.family;
  }
  if (!isAllowedAddress(pinnedAddress, options.allowLocal)) throw new Error(`Blocked non-public address: ${pinnedAddress}`);

  const lookup: NonNullable<RequestOptions['lookup']> = (_host, lookupOptions, callback) => {
    const cb = callback as (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
    if (typeof lookupOptions === 'object' && lookupOptions.all) cb(null, [{ address: pinnedAddress, family }]);
    else cb(null, pinnedAddress, family);
  };
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
  return await new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    const requestRef: { current?: ReturnType<typeof httpRequest> } = {};
    let responseRef: import('node:http').IncomingMessage | undefined;
    let decodedRef: (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
    const timer = setTimeout(() => fail(new Error('Request deadline exceeded')), remaining);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      decodedRef?.destroy?.();
      responseRef?.destroy();
      requestRef.current?.destroy();
      reject(error);
    };
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      method: 'GET',
      headers: { 'accept-encoding': 'gzip, br, deflate', 'user-agent': 'script-harbor/0.1' },
      lookup,
      agent: false,
    }, (response) => {
      responseRef = response;
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        settled = true;
        clearTimeout(timer);
        resolve({ status, headers: { ...response.headers, location }, body: Buffer.alloc(0) });
        return;
      }
      let decoded: NodeJS.ReadableStream;
      response.once('aborted', () => fail(new Error('Response aborted before completion')));
      response.once('error', fail);
      try { decoded = decodeStream(response, response.headers['content-encoding']); }
      catch (error) { fail(error as Error); return; }
      decodedRef = decoded;
      void collectBody(decoded, options.maxBytes).then((body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, headers: response.headers, body });
      }, fail);
    });
    requestRef.current = req;
    req.once('error', fail);
    req.end();
  });
}

export async function fetchResource(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a nonnegative integer');
  const originalUrl = checkedUrl(input);
  const deadline = Date.now() + timeoutMs;
  let current = originalUrl;
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestHop(current, { allowLocal: options.allowLocal === true, maxBytes, deadline });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirects >= maxRedirects) throw new Error(`Too many redirects (limit ${maxRedirects})`);
      current = checkedUrl(new URL(response.headers.location, current).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status} for ${current.href}`);
    const contentType = response.headers['content-type']?.trim().toLowerCase() || 'application/octet-stream';
    return { url: originalUrl.href, finalUrl: current.href, body: response.body, contentType, status: response.status };
  }
}
