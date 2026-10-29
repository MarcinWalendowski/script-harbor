import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { requestReview } from '../src/providers.js';
import type { Provider, ReviewOptions } from '../src/types.js';

const review = {
  verdict: 'review-required', summary: 'Inspect this source manually.', findings: [],
  relocation: { safe: false, reason: 'Review behavior and origin assumptions.' },
};

type Handler = (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void;

async function withServer(handler: Handler, run: (endpoint: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${address.port}/review`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function responseFor(provider: Provider): unknown {
  const text = JSON.stringify(review);
  if (provider === 'openrouter') return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
  if (provider === 'claude') return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
  return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
}

function options(provider: Provider, endpoint: string): ReviewOptions {
  return { provider, model: 'explicit-model', apiKey: 'test-secret', endpoint };
}

for (const provider of ['openrouter', 'claude', 'codex'] as const) {
  test(`${provider} adapter sends the documented tool-free request and validates its response`, async () => {
    await withServer((request, response, body) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, provider === 'claude' ? undefined : 'Bearer test-secret');
      if (provider === 'claude') {
        assert.equal(request.headers['x-api-key'], 'test-secret');
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
        assert.equal(body.system && typeof body.system, 'string');
        assert.deepEqual(body.messages, [{ role: 'user', content: (body.messages as Array<{ content: string }>)[0]?.content }]);
        assert.equal(body.model, 'explicit-model');
      } else if (provider === 'openrouter') {
        assert.equal(body.model, 'explicit-model');
        assert.equal((body.messages as Array<{ role: string }>)[0]?.role, 'system');
        assert.equal((body.messages as Array<{ role: string }>)[1]?.role, 'user');
        assert.equal('tools' in body, false);
      } else {
        assert.equal(body.model, 'explicit-model');
        assert.equal(typeof body.instructions, 'string');
        assert.equal(typeof body.input, 'string');
        assert.equal(body.store, false);
        assert.equal('tools' in body, false);
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseFor(provider)));
    }, async (endpoint) => {
      const result = await requestReview('console.log("review me")', options(provider, endpoint));
      assert.equal(result.verdict, 'review-required');
    });
  });
}

test('Claude refusal/tool blocks and incomplete responses are rejected', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x' }] }));
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('claude', endpoint)), /incomplete or refused/);
  });
});

test('Codex refusal and unfinished response are rejected', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'incomplete', output: [] }));
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('codex', endpoint)), /incomplete or refused/);
  });
});

test('Codex accepts reasoning metadata alongside the final review', async () => {
  await withServer((_request, response) => {
    response.end(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(review) }] },
    ] }));
  }, async endpoint => {
    assert.equal((await requestReview('source', options('codex', endpoint))).verdict, 'review-required');
  });
});

test('large complete source requires an explicit context budget and is never truncated', async () => {
  const source = 'a'.repeat(527209);
  await withServer((_request, response, body) => {
    assert.ok((body.input as string).endsWith(source));
    response.end(JSON.stringify(responseFor('codex')));
  }, async endpoint => {
    assert.equal((await requestReview(source, { ...options('codex', endpoint), maxChars: 1_000_000 })).verdict, 'review-required');
  });
});

test('OpenRouter length finish reason is rejected', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('openrouter', endpoint)), /incomplete or refused/);
  });
});

test('invalid provider JSON and invalid review schema are rejected without echoing response content', async () => {
  await withServer((_request, response) => response.end('not json secret-in-body'), async (endpoint) => {
    await assert.rejects(requestReview('source', options('openrouter', endpoint)), (error: Error) => {
      assert.match(error.message, /invalid JSON/);
      assert.equal(error.message.includes('secret-in-body'), false);
      return true;
    });
  });
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"low-risk"}' } }] }));
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('openrouter', endpoint)), /required schema/);
  });
});

test('transient provider errors retry up to three attempts, while permanent errors are sanitized', async () => {
  let count = 0;
  await withServer((_request, response) => {
    count += 1;
    if (count < 3) { response.statusCode = 503; response.end('contains-secret'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responseFor('openrouter')));
  }, async (endpoint) => {
    const result = await requestReview('source', options('openrouter', endpoint));
    assert.equal(result.verdict, 'review-required');
    assert.equal(count, 3);
  });
  await withServer((_request, response) => {
    response.statusCode = 401;
    response.end('contains-secret');
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('openrouter', endpoint)), (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.message.includes('contains-secret'), false);
      return true;
    });
  });
});

test('redirects, non-loopback HTTP endpoints, source overflow, and external provider requests fail closed', async () => {
  await assert.rejects(requestReview('source', { provider: 'openrouter', model: 'x', apiKey: 'secret', endpoint: 'http://example.test/api' }), /HTTPS/);
  await assert.rejects(requestReview('x'.repeat(200_001), { provider: 'openrouter', model: 'x', apiKey: 'secret' }), /exceeds review limit/);
  await assert.rejects(requestReview('source', { provider: 'external', model: 'x', apiKey: 'secret' }), /imported/);
  await withServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', 'https://attacker.invalid/collect');
    response.end();
  }, async (endpoint) => {
    await assert.rejects(requestReview('source', options('openrouter', endpoint)), /redirects are not allowed/);
  });
});
