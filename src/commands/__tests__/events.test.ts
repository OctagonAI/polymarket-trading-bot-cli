import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import type { ParsedArgs } from '../parse-args.js';
import type { OctagonEventEntry } from '../../scan/octagon-events-api.js';

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

  test('event detail renders sub-markets the model has not priced', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const event = {
      event_ticker: 'mlb-wsh-det-2026-09-23', name: 'Nationals vs. Tigers', series_category: 'Sports',
      model_probability: 33.5, market_probability: 39, edge_pp: -5.5, confidence_score: 5,
      total_volume: 100, total_open_interest: 0, close_time: '2026-09-30T17:10:00Z', key_takeaway: null,
      outcome_probabilities: [
        { market_ticker: 'mlb-wsh-det-2026-09-23', outcome_name: 'Washington Nationals', model_probability: 33.5, market_probability: 39 },
        { market_ticker: 'mlb-wsh-det-2026-09-23-f5-total-2pt5', outcome_name: '1st 5 Innings O/U 2.5', model_probability: null, market_probability: 0 },
        { market_ticker: 'mlb-wsh-det-2026-09-23-f5-total-3pt5', outcome_name: '1st 5 Innings O/U 3.5', model_probability: null, market_probability: null },
      ],
    } as unknown as import('../../scan/octagon-events-api.js').OctagonEventEntry;

    const out = formatEventsHuman({ kind: 'detail', event });
    expect(out).toContain('-5.5pp');
    // The unpriced rows are listed, with no model value and no edge — labelled by
    // the words that differ from their siblings, not the full shared slug.
    expect(out).toMatch(/│ 2pt5 +│ 1st 5 Innings O\/U 2\.5 +│ - +│ 0\.0% +│ - +│/);
    expect(out).toMatch(/│ 3pt5 +│ 1st 5 Innings O\/U 3\.5 +│ - +│ - +│ - +│/);
    expect(out).not.toContain('f5-total');
    expect(out).not.toContain('NaN');
  });
});

/** /predictions/events/{ref} after the slimming: no report prose or trust fields, plus event_url and markets[]. */
function slimEvent(overrides: Partial<OctagonEventEntry> = {}): OctagonEventEntry {
  return {
    history_id: 41,
    run_id: '1a9984cc-17b8-4d59-936b-ebaa0d0da5c5',
    captured_at: '2026-09-23T17:53:00Z',
    event_ticker: 'fed-decision-in-october',
    venue: 'polymarket',
    name: 'Fed decision in October?',
    slug: 'fed-decision-in-october',
    series_category: 'Economics',
    meta_category: 'economics',
    available_on_brokers: false,
    mutually_exclusive: true,
    analysis_last_updated: '2026-09-23T17:40:00Z',
    confidence_score: 7,
    model_probability: 62,
    market_probability: 55,
    edge_pp: 7,
    expected_return: 0.12,
    r_score: 1.4,
    total_volume: 2_500_000,
    total_open_interest: 0,
    close_time: '2026-10-29T18:00:00Z',
    key_takeaway: 'A 25bp cut is the base case; a hold needs a hot CPI print.',
    event_url: 'https://polymarket.com/event/fed-decision-in-october',
    outcome_probabilities: [
      { market_ticker: 'fed-decreases-interest-rates-by-25-bps-after-october-2026-meeting', outcome_name: '25 bps decrease', model_probability: 62, market_probability: 55, volume_24h: 80_000 },
      { market_ticker: 'no-change-in-fed-interest-rates-after-october-2026-meeting', outcome_name: 'No change', model_probability: 35, market_probability: 42, volume_24h: 60_000 },
    ],
    markets: [
      {
        market_ticker: 'fed-decreases-interest-rates-by-25-bps-after-october-2026-meeting', outcome_name: '25 bps decrease',
        model_probability: 62, market_probability: 55, model_probability_source: 'model', evidence_grade: 'B',
        volume: 1_500_000, volume_24h: 80_000, yes_bid: 0.54, yes_ask: 0.56, no_bid: 0.44, no_ask: 0.46, status: 'active',
      },
      {
        market_ticker: 'no-change-in-fed-interest-rates-after-october-2026-meeting', outcome_name: 'No change',
        model_probability: 35, market_probability: 42, model_probability_source: 'model', evidence_grade: 'B',
        volume: 1_000_000, volume_24h: 60_000, yes_bid: 0.41, yes_ask: 0.43, no_bid: 0.57, no_ask: 0.59, status: 'active',
      },
    ],
    ...overrides,
  };
}

const DROPPED_FIELDS = /richtext|trader_trust|executive_summary|q[1-5]_|candlestick|analysis_version|analysis_owner/;

describe('Events command — slimmed event detail', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    process.env.OCTAGON_API_KEY = 'sk_test';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCTAGON_API_KEY;
  });

  test('renders every detail line, including the takeaway', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const out = formatEventsHuman({ kind: 'detail', event: slimEvent() });
    expect(out).toContain('Event fed-decision-in-october — Fed decision in October?');
    expect(out).toContain('Category   Economics');
    expect(out).toContain('Model      62.0%');
    expect(out).toContain('Market     55.0%');
    expect(out).toContain('Edge       +7.0pp  (confidence 7.0/10)');
    expect(out).toContain('Volume     2.5M');
    expect(out).toContain('Closes     2026-10-29T18:00:00Z');
    expect(out).toContain('A 25bp cut is the base case; a hold needs a hot CPI print.');
    expect(out).toContain('25 bps decrease');
    expect(out).toContain('No change');
  });

  test('--json carries the response as served, with no dropped field', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(slimEvent()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const { handleEvents } = await import('../events.js');
    const resp = await handleEvents(makeArgs({ positionalArgs: ['fed-decision-in-october'] }));
    expect(resp.ok).toBe(true);
    if (!resp.ok || resp.data.kind !== 'detail') throw new Error();
    const json = JSON.stringify(resp);
    expect(json).not.toMatch(DROPPED_FIELDS);
    expect(resp.data.event.event_url).toBe('https://polymarket.com/event/fed-decision-in-october');
    expect(resp.data.event.markets).toHaveLength(2);
  });
});

describe('Events command — snapshot time', () => {
  // A week after the fixtures' captured_at of 2026-09-23 17:53 UTC.
  beforeEach(() => { setSystemTime(new Date('2026-09-30T17:53:00Z')); });
  afterEach(() => { setSystemTime(); });

  test('detail shows when the numbers were captured, right under the header', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const lines = formatEventsHuman({ kind: 'detail', event: slimEvent() }).split('\n');
    expect(lines[0]).toBe('Event fed-decision-in-october — Fed decision in October?');
    expect(lines[1]).toBe('  Snapshot   2026-09-23 17:53 UTC (7d ago)');
  });

  test('detail names the analysis date only when it predates the capture by over a day', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const carried = formatEventsHuman({ kind: 'detail', event: slimEvent({ analysis_last_updated: '2026-09-02T09:15:00Z' }) });
    expect(carried).toContain('  Snapshot   2026-09-23 17:53 UTC (7d ago) · analysis from 2026-09-02');

    const fresh = formatEventsHuman({ kind: 'detail', event: slimEvent({ analysis_last_updated: '2026-09-22T20:00:00Z' }) });
    expect(fresh).not.toContain('analysis from');
  });

  test('a zone-less captured_at is read as UTC', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const out = formatEventsHuman({ kind: 'detail', event: slimEvent({ captured_at: '2026-09-23T17:53:00' }) });
    expect(out).toContain('  Snapshot   2026-09-23 17:53 UTC (7d ago)');
  });

  test('an unparseable captured_at drops the line instead of crashing', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const out = formatEventsHuman({ kind: 'detail', event: slimEvent({ captured_at: 'not-a-date' }) });
    expect(out).not.toContain('Snapshot');
    expect(out).toContain('Model      62.0%');
  });

  test('list has a Captured column with the compact age', async () => {
    const { formatEventsHuman } = await import('../events.js');
    const data = [
      slimEvent({ event_ticker: 'fresh-event', captured_at: '2026-09-30T14:53:00Z' }),
      slimEvent({ event_ticker: 'stale-event' }),
      slimEvent({ event_ticker: 'undated-event', captured_at: '' }),
    ];
    const out = formatEventsHuman({ kind: 'list', data, total_returned: data.length });
    expect(out).toMatch(/Captured/);
    expect(out).toMatch(/fresh-event .*│ 3h +│/);
    expect(out).toMatch(/stale-event .*│ 7d +│/);
    expect(out).toMatch(/undated-event .*│ - +│/);
  });
});
