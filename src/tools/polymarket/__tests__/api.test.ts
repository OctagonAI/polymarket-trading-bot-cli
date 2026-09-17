import { resetPortfolioCaches } from '../portfolio.js';
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

describe('fetchPositions pagination', () => {
  test('pages until a short page and preserves an explicit limit as one page', async () => {
    const { fetchPositions } = await import('../portfolio.js');
    resetPortfolioCaches(); // the 15s read cache would otherwise serve a prior case's pages
    const wallet = '0x' + '1'.repeat(40);

    const seen: string[] = [];
    const makePage = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ slug: `m${i}`, size: 1, avgPrice: 0.5, curPrice: 0.5 }));

    // A wallet holding 207 positions, served in pages that honour limit/offset.
    const TOTAL = 207;
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      const q = new URL(url).searchParams;
      const limit = Number(q.get('limit') ?? 100);
      const offset = Number(q.get('offset') ?? 0);
      const body = makePage(Math.max(0, Math.min(limit, TOTAL - offset)));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const all = await fetchPositions(wallet);
    expect(all).toHaveLength(TOTAL);   // 100 + 100 + 7 — the unpaged call returned 100
    expect(seen).toHaveLength(3);

    seen.length = 0;
    const capped = await fetchPositions(wallet, { limit: 5 });
    expect(seen).toHaveLength(1);      // explicit limit means one request, not a walk
    expect(capped).toHaveLength(5);
  });

  test('a wallet past the page cap is truncated, but says so', async () => {
    // 20 pages x 100 = 2,000. A wallet with 2,001 exceeds the cap: the walk stops
    // with a full final page, returns 2,000, and must warn rather than let the
    // caller treat a partial list as complete.
    const { fetchPositions } = await import('../portfolio.js');
    resetPortfolioCaches(); // the 15s read cache would otherwise serve a prior case's pages
    const { logger } = await import('../../../utils/logger.js');
    const wallet = '0x' + '1'.repeat(40);

    const warnings: string[] = [];
    const realWarn = logger.warn.bind(logger);
    logger.warn = ((m: string) => { warnings.push(m); }) as typeof logger.warn;

    const TOTAL = 2001;
    let requests = 0;
    globalThis.fetch = (async (url: string) => {
      requests += 1;
      const q = new URL(url).searchParams;
      const limit = Number(q.get('limit') ?? 100);
      const offset = Number(q.get('offset') ?? 0);
      const n = Math.max(0, Math.min(limit, TOTAL - offset));
      const body = Array.from({ length: n }, (_, i) => ({ slug: `m${offset + i}`, size: 1 }));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    try {
      const all = await fetchPositions(wallet);
      expect(requests).toBe(20);       // stopped at the cap, not at a short page
      expect(all).toHaveLength(2000);  // the 2,001st is not returned
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('truncated');
      expect(warnings[0]).toContain('understated');
    } finally {
      logger.warn = realWarn;
    }
  });

  test('a wallet exactly at the page cap also warns — an accepted false positive', async () => {
    // Exactly 2,000 ends on a full 20th page too, but nothing is missing. This is
    // the acceptable false positive of the "full final page" heuristic — assert
    // the current behaviour so a change to it is deliberate.
    const { fetchPositions } = await import('../portfolio.js');
    resetPortfolioCaches(); // the 15s read cache would otherwise serve a prior case's pages
    const { logger } = await import('../../../utils/logger.js');
    const wallet = '0x' + '1'.repeat(40);

    const warnings: string[] = [];
    const realWarn = logger.warn.bind(logger);
    logger.warn = ((m: string) => { warnings.push(m); }) as typeof logger.warn;

    const TOTAL = 2000;
    globalThis.fetch = (async (url: string) => {
      const q = new URL(url).searchParams;
      const limit = Number(q.get('limit') ?? 100);
      const offset = Number(q.get('offset') ?? 0);
      const n = Math.max(0, Math.min(limit, TOTAL - offset));
      return new Response(
        JSON.stringify(Array.from({ length: n }, (_, i) => ({ slug: `m${offset + i}`, size: 1 }))),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const all = await fetchPositions(wallet);
      expect(all).toHaveLength(2000);
      // Warns even though nothing was lost — a false positive we accept, because
      // the alternative is a 21st request on every maxed-out wallet.
      expect(warnings).toHaveLength(1);
    } finally {
      logger.warn = realWarn;
    }
  });
});
