import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ParsedArgs } from '../parse-args.js';
import { handleReport, formatReportHuman } from '../report.js';
import type { OctagonEventEntry } from '../../scan/octagon-events-api.js';

function makeArgs(o: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'report',
    positionalArgs: [],
    json: false,
    live: false, refresh: false, report: false, dryRun: false, verbose: false,
    performance: false, resolved: false, unresolved: false, activeOnly: false,
    force: false,
    yes: false,
    all: false,
    parseErrors: [],
    ...o,
  };
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function installFetchMock(handler: FetchHandler): void {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const s = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(s, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** /predictions/events/{ref} after the slimming: no report prose or trust fields, plus event_url and markets[]. */
const SLIM_EVENT_DETAIL = {
  history_id: 41,
  run_id: '1a9984cc-17b8-4d59-936b-ebaa0d0da5c5',
  captured_at: '2026-09-23T17:53:00Z',
  event_ticker: 'when-will-tim-cook-leave-apple',
  venue: 'polymarket',
  name: 'When will Tim Cook leave Apple?',
  slug: 'when-will-tim-cook-leave-apple',
  series_category: 'Business',
  meta_category: 'business',
  available_on_brokers: false,
  mutually_exclusive: false,
  analysis_last_updated: '2026-09-02T09:15:00Z',
  confidence_score: 6,
  model_probability: 30,
  market_probability: 25,
  edge_pp: 5,
  expected_return: 0.2,
  r_score: 1.1,
  total_volume: 120_000,
  total_open_interest: 0,
  close_time: '2027-12-31T00:00:00Z',
  key_takeaway: 'Succession planning is visible but not imminent.',
  event_url: 'https://polymarket.com/event/when-will-tim-cook-leave-apple',
  outcome_probabilities: [
    { market_ticker: 'tim-cook-out-by-2027', outcome_name: 'By 2027', model_probability: 30, market_probability: 25 },
  ],
  markets: [
    {
      market_ticker: 'tim-cook-out-by-2027', outcome_name: 'By 2027', model_probability: 30, market_probability: 25,
      model_probability_source: 'model', evidence_grade: 'B', volume: 120_000, volume_24h: 3_000,
      yes_bid: 0.24, yes_ask: 0.26, no_bid: 0.74, no_ask: 0.76, status: 'active',
    },
  ],
} satisfies OctagonEventEntry;


describe('handleReport', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    process.env.OCTAGON_API_KEY = 'sk_test';
    process.env.POLYMARKET_API_KEY = 'test-key';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCTAGON_API_KEY;
    delete process.env.POLYMARKET_API_KEY;
  });

  test('missing ticker → MISSING_TICKER', async () => {
    installFetchMock(() => jsonResponse({}));
    const resp = await handleReport(makeArgs({ positionalArgs: [] }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('MISSING_TICKER');
  });

  test('Octagon event lookup 404 + market resolver failure → EVENT_NOT_FOUND', async () => {
    installFetchMock((url) => {
      // Octagon events endpoint 404; Gamma /markets, /events all 404
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    });
    const resp = await handleReport(makeArgs({ positionalArgs: ['KX-BOGUS'] }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('EVENT_NOT_FOUND');
  });

  test('normalizes a Polymarket URL to a slug before lookup', async () => {
    let eventLookupUrl = '';
    installFetchMock((url) => {
      if (url.includes('/v1/predictions/events/')) {
        // Capture the FIRST lookup (the user-input → event), not the later
        // re-lookup with the canonical event_ticker.
        if (!eventLookupUrl) eventLookupUrl = url;
        return jsonResponse({
          event_ticker: 'measles-cases-2026',
          name: 'Measles cases in 2026',
        });
      }
      return jsonResponse({});
    });
    // Call but ignore the eventual "no report body" branch — we only
    // care that the input got normalized before being sent to Octagon.
    await handleReport(makeArgs({
      positionalArgs: ['https://polymarket.com/event/measles-cases-2026?ref=share'],
    }));
    expect(eventLookupUrl).toContain('/measles-cases-2026');
  });

  test('uses outcome_probabilities market_ticker for the Octagon invoker URL', async () => {
    // When the Octagon event_ticker is an event slug that is not itself a
    // market, the report command must pick a real market slug from
    // outcome_probabilities before handing it to the invoker.
    const gammaMarketCalls: string[] = [];
    installFetchMock((url) => {
      if (url.includes('/v1/predictions/events/')) {
        return jsonResponse({
          event_ticker: 'when-will-tim-cook-leave-apple',
          name: 'When will Tim Cook leave Apple?',
          outcome_probabilities: [
            { market_ticker: 'tim-cook-out-by-2027', model_probability: 30, market_probability: 25 },
          ],
        });
      }
      if (url.includes('gamma-api.polymarket.com/markets')) {
        gammaMarketCalls.push(url);
        return jsonResponse([
          {
            slug: 'tim-cook-out-by-2027',
            conditionId: '0x' + 'b'.repeat(64),
            question: 'Tim Cook out by 2027?',
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.25", "0.75"]',
            clobTokenIds: '["1", "2"]',
            events: [{ slug: 'when-will-tim-cook-leave-apple' }],
            active: true,
            closed: false,
          },
        ]);
      }
      // Cached reports are read straight from the Reports API, not the agent.
      if (url.includes('/predictions/reports/polymarket/')) {
        return jsonResponse({
          event_ticker: 'when-will-tim-cook-leave-apple',
          venue: 'polymarket',
          versions: [{ run_id: 'r1' }],
          markdown_report: '# Report body',
          run_id: 'r1',
        });
      }
      return jsonResponse({});
    });
    const resp = await handleReport(makeArgs({ positionalArgs: ['when-will-tim-cook-leave-apple'] }));
    expect(resp.ok).toBe(true);
    // The invoker's market lookup must use the market slug, not the event slug.
    expect(gammaMarketCalls.length).toBeGreaterThan(0);
    expect(gammaMarketCalls[0]).toContain('slug=tim-cook-out-by-2027');
  });

  test('resolves title, analysis time and market from a slimmed event detail', async () => {
    const gammaMarketCalls: string[] = [];
    installFetchMock((url) => {
      if (url.includes('/v1/predictions/events/')) return jsonResponse(SLIM_EVENT_DETAIL);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        gammaMarketCalls.push(url);
        return jsonResponse([
          {
            slug: 'tim-cook-out-by-2027',
            conditionId: '0x' + 'b'.repeat(64),
            question: 'Tim Cook out by 2027?',
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.25", "0.75"]',
            clobTokenIds: '["1", "2"]',
            events: [{ slug: 'when-will-tim-cook-leave-apple' }],
            active: true,
            closed: false,
          },
        ]);
      }
      if (url.includes('/predictions/reports/polymarket/')) {
        return jsonResponse({
          event_ticker: 'when-will-tim-cook-leave-apple',
          venue: 'polymarket',
          versions: [{ run_id: 'r1' }],
          markdown_report: '# Report body',
          run_id: 'r1',
        });
      }
      return jsonResponse({});
    });
    const resp = await handleReport(makeArgs({ positionalArgs: ['when-will-tim-cook-leave-apple'] }));
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data.title).toBe('When will Tim Cook leave Apple?');
    expect(resp.data.modelRunAt).toBe('2026-09-02 09:15 UTC');
    expect(gammaMarketCalls[0]).toContain('slug=tim-cook-out-by-2027');
    expect(formatReportHuman(resp.data)).toContain('Report body updated at: 2026-09-02 09:15 UTC');
  });
});

describe('formatReportHuman', () => {
  test('renders markdown body with header + footer metadata', () => {
    const out = formatReportHuman({
      ticker: 'KXAAPLCEOCHANGE-26',
      requestedTicker: 'KXAAPLCEOCHANGE',
      title: 'When will Tim Cook leave Apple?',
      source: 'cache',
      rawReport: '# Tim Cook tenure\n\nNo signs of imminent departure.',
      refreshedAt: '2026-06-25 12:00 UTC',
      modelRunAt: '2026-06-25 10:30 UTC',
      reportAge: '5m ago',
    });
    expect(out).toContain('KXAAPLCEOCHANGE-26');
    expect(out).toContain('Tim Cook tenure');
    expect(out).toContain('No signs of imminent departure');
    expect(out).toContain('When will Tim Cook leave Apple?');
    expect(out).toContain('Cache refreshed at:    2026-06-25 12:00 UTC (5m ago)');
    expect(out).toContain('Report body updated at: 2026-06-25 10:30 UTC');
    expect(out).toMatch(/cached.*--refresh/);
  });

  test('omits metadata lines that are null', () => {
    const out = formatReportHuman({
      ticker: 'KX-A',
      requestedTicker: 'KX-A',
      title: null,
      source: 'fresh',
      rawReport: '# Body',
      refreshedAt: null,
      modelRunAt: null,
      reportAge: null,
    });
    expect(out).not.toContain('Title:');
    expect(out).not.toContain('Cache refreshed at:');
    expect(out).not.toContain('Report body updated at:');
    expect(out).toContain('freshly generated');
  });
});
