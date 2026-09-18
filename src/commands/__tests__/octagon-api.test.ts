import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ParsedArgs } from '../parse-args.js';
import { handleSimilar } from '../similar.js';

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'chat',
    positionalArgs: [],
    json: false,
    live: false,
    refresh: false,
    report: false,
    dryRun: false,
    verbose: false,
    performance: false,
    resolved: false,
    unresolved: false,
    activeOnly: false,
    force: false,
    yes: false,
    all: false,
    parseErrors: [],
    ...overrides,
  };
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetchMock(handler: FetchHandler) {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(urlStr, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Octagon API commands', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.OCTAGON_API_KEY = 'sk_test_key';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCTAGON_API_KEY;
  });

  test('handleSimilar: ticker anchor', async () => {
    installFetchMock((url) => {
      expect(url).toContain('/predictions/markets/similar');
      expect(url).toContain('venues=polymarket');
      expect(url).toContain('anchor_ticker=polymarket__will-btc-hit-100k-by-dec-2026');
      return jsonResponse({
        data: [{
          market_ticker: 'polymarket__will-eth-hit-10k-by-dec-2026',
          native_ticker: 'will-eth-hit-10k-by-dec-2026',
          venue: 'polymarket',
          event_ticker: 'polymarket__crypto-price-targets-2026',
          title: 'ETH above $10k by Dec 2026',
          status: 'active',
          close_time: '2026-12-31T23:59:59Z',
          category: 'crypto',
          distance: 0.18,
        }],
        next_cursor: null,
        has_more: false,
      });
    });

    const resp = await handleSimilar(makeArgs({ subcommand: 'similar', positionalArgs: ['will-btc-hit-100k-by-dec-2026'], topK: 5 }));
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.data).toHaveLength(1);
    expect(resp.data.data[0].distance).toBe(0.18);
    // The anchor is re-attached client-side now that the API no longer echoes it.
    expect(resp.data.anchor_ticker).toBe('will-btc-hit-100k-by-dec-2026');
  });

  test('handleSimilar: free-text query routed to -q', async () => {
    installFetchMock((url) => {
      expect(url).toContain('/predictions/markets/similar');
      expect(url).toMatch(/q=[^&]*Bitcoin/);
      return jsonResponse({ data: [], next_cursor: null, has_more: false });
    });
    const resp = await handleSimilar(makeArgs({ subcommand: 'similar', query: 'Will Bitcoin pierce six figures' }));
    expect(resp.ok).toBe(true);
  });

  test('handleSimilar: rejects missing anchor', async () => {
    installFetchMock(() => jsonResponse({}));
    const resp = await handleSimilar(makeArgs({ subcommand: 'similar' }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('MISSING_ANCHOR');
  });

  test('batch analyze: single POST /markets/edge for N tickers', async () => {
    let edgeBody: any;
    installFetchMock(async (url, init) => {
      expect(url).toContain('/markets/edge');
      edgeBody = JSON.parse((init?.body as string) ?? '{}');
      return jsonResponse({
        run_id: 'r1', captured_at: '2026-05-27T00:00:00Z',
        data: [
          { input_ticker: 'KX-A', market_ticker: 'KX-A', event_ticker: 'KX-A', title: 'A', series_category: 'X', model_probability: 0.6, market_probability: 0.55, edge_pp: 5, expected_return: 0.09, confidence_score: 7, total_volume: 1000, total_open_interest: 200, status: 'scored', captured_at: 'now' },
          { input_ticker: 'KX-B', market_ticker: 'KX-B', event_ticker: 'KX-B', title: null, series_category: null, model_probability: null, market_probability: null, edge_pp: null, expected_return: null, confidence_score: null, total_volume: null, total_open_interest: null, status: 'unscored', captured_at: null },
        ],
      });
    });
    const { handleAnalyzeBatch } = await import('../analyze-batch.js');
    const resp = await handleAnalyzeBatch(['KX-A', 'KX-B']);
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(edgeBody.tickers).toEqual(['KX-A', 'KX-B']);
    expect(resp.data.scored).toBe(1);
    expect(resp.data.unscored).toBe(1);
  });

  test('batch analyze: rejects empty list', async () => {
    installFetchMock(() => jsonResponse({}));
    const { handleAnalyzeBatch } = await import('../analyze-batch.js');
    const resp = await handleAnalyzeBatch([]);
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('NO_TICKERS');
  });

  test('batch analyze: rejects > 100 tickers', async () => {
    installFetchMock(() => jsonResponse({}));
    const { handleAnalyzeBatch } = await import('../analyze-batch.js');
    const tickers = Array.from({ length: 101 }, (_, i) => `KX-${i}`);
    const resp = await handleAnalyzeBatch(tickers);
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('TOO_MANY_TICKERS');
  });

  test('batch analyze: dedupes + uppercases', async () => {
    let edgeBody: any;
    installFetchMock(async (_url, init) => {
      edgeBody = JSON.parse((init?.body as string) ?? '{}');
      return jsonResponse({ run_id: 'r', captured_at: 'now', data: [] });
    });
    const { handleAnalyzeBatch } = await import('../analyze-batch.js');
    await handleAnalyzeBatch(['kx-a', ' KX-A ', 'kx-b']);
    expect(edgeBody.tickers).toEqual(['KX-A', 'KX-B']);
  });

  test('formatMarketsWithEdgeHuman guards against invalid captured_at', async () => {
    const { formatMarketsWithEdgeHuman } = await import('../search-remote.js');
    // Should not throw when captured_at is invalid garbage.
    const out = formatMarketsWithEdgeHuman({
      run_id: '12345678-aaaa', captured_at: 'not-a-date', sort_by: 'edge_pp',
      data: [], next_cursor: null, has_more: false,
    } as any, 5);
    expect(out).toContain('captured unknown');
    // Should also handle null
    const out2 = formatMarketsWithEdgeHuman({
      run_id: '12345678-aaaa', captured_at: null, sort_by: 'edge_pp',
      data: [], next_cursor: null, has_more: false,
    } as any, 5);
    expect(out2).toContain('captured unknown');
  });

  test('Octagon API: 502 surfaces as wrapped error', async () => {
    installFetchMock(() => new Response(JSON.stringify({ detail: 'upstream embedding failed' }), { status: 502 }));
    const resp = await handleSimilar(makeArgs({ subcommand: 'similar', query: 'foo' }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.message).toContain('502');
    expect(resp.error?.message).toContain('upstream embedding failed');
  });
});
