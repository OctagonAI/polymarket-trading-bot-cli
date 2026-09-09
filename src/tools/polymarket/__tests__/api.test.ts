import { describe, test, expect, afterEach } from 'bun:test';
import { callPolymarketApi, PolymarketApiError } from '../api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('callPolymarketApi request deadline', () => {
  test('every request carries an AbortSignal', async () => {
    // Without one, a half-open connection never settles: the promise hangs,
    // withRetry never sees an error, and the CLI stalls forever.
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    await callPolymarketApi('gamma', 'GET', '/markets');

    expect(seen?.signal).toBeDefined();
    expect(seen!.signal!.aborted).toBe(false);
  });

  test('an aborted request surfaces as a retryable 408, not a bare AbortError', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Second call succeeds, so the retry path is exercised without waiting out
      // the full backoff ladder.
      if (calls === 1) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await callPolymarketApi<{ ok: boolean }>('clob', 'GET', '/ok');
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  test('a non-abort network error is not rewritten', async () => {
    globalThis.fetch = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    await expect(callPolymarketApi('data', 'GET', '/positions')).rejects.toThrow('network down');
  });
});

describe('PolymarketApiError', () => {
  test('carries the service that failed', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

    await expect(callPolymarketApi('gamma', 'GET', '/markets')).rejects.toMatchObject({
      statusCode: 404,
      service: 'gamma',
    });
    expect(PolymarketApiError).toBeDefined();
  });
});
