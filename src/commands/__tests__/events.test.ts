import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ParsedArgs } from '../parse-args.js';

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'events',
    positionalArgs: [],
    json: false,
    live: false, refresh: false, report: false, dryRun: false, verbose: false,
    performance: false, resolved: false, unresolved: false, activeOnly: false,
    force: false,
    yes: false,
    all: false,
    parseErrors: [],
    ...overrides,
  };
}

describe('Events command', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.OCTAGON_API_KEY = 'sk_test';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCTAGON_API_KEY;
  });

  test('events list paginates and sorts', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const s = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      expect(s).toContain('/predictions/events');
      expect(s).toContain('venue=polymarket');
      return new Response(JSON.stringify({
        data: [
          { event_ticker: 'btc-100k-2026', name: 'A', series_category: 'Crypto', model_probability: 50, market_probability: 45, edge_pp: 5, confidence_score: 8, total_volume: 100, total_open_interest: 50, expected_return: 0.05, close_time: '2026-12-31T00:00:00Z', key_takeaway: '', captured_at: '', history_id: 1, run_id: 'r', slug: 'a', available_on_brokers: true, mutually_exclusive: false, analysis_last_updated: '', r_score: 0 },
          { event_ticker: 'us-election-winner', name: 'B', series_category: 'Politics', model_probability: 60, market_probability: 50, edge_pp: 10, confidence_score: 9, total_volume: 500, total_open_interest: 200, expected_return: 0.10, close_time: '2026-06-01T00:00:00Z', key_takeaway: '', captured_at: '', history_id: 2, run_id: 'r', slug: 'b', available_on_brokers: true, mutually_exclusive: false, analysis_last_updated: '', r_score: 0 },
        ],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const { handleEvents } = await import('../events.js');
    const resp = await handleEvents(makeArgs({ subcommand: 'events' }));
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    if (resp.data.kind !== 'list') throw new Error();
    // Sorted by total_volume desc: us-election-winner (500) before btc-100k-2026 (100)
    expect(resp.data.data[0].event_ticker).toBe('us-election-winner');
    expect(resp.data.data[1].event_ticker).toBe('btc-100k-2026');
  });
});
