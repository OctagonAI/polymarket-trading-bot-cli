import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import type { ParsedArgs } from '../parse-args.js';
import { getDb, closeDb } from '../../db/index.js';
import { handleEditorialThemes } from '../editorial-themes.js';

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'themes',
    positionalArgs: [],
    json: false,
    live: false, refresh: false, report: false, dryRun: false, verbose: false,
    performance: false, resolved: false, unresolved: false,
    behavioral: false, ranked: false, showCluster: false, activeOnly: false, cells: false, autoProbs: false,
    force: false,
    check: false,
    yes: false,
    all: false,
    parseErrors: [],
    ...overrides,
  };
}

describe('Editorial themes registry', () => {
  beforeEach(() => {
    closeDb();
    // Initialize the singleton at :memory: for this test
    getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  test('list empty registry returns error with helpful message', async () => {
    const resp = await handleEditorialThemes(makeArgs({ positionalArgs: [] }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('EMPTY_REGISTRY');
    expect(resp.error?.message).toContain('themes import');
  });

  test('create then list', async () => {
    const create = await handleEditorialThemes(makeArgs({
      positionalArgs: ['create', 'AI', 'Race'],
      labelContains: 'AI markets',
      tickers: 'KXGPT,KXCLAUDE',
    }));
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    expect(create.data.kind).toBe('mutation');

    const list = await handleEditorialThemes(makeArgs({ positionalArgs: ['list'] }));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    if (list.data.kind !== 'list') throw new Error();
    expect(list.data.data).toHaveLength(1);
    expect(list.data.data[0].name).toBe('AI Race');
  });

  test('show drills into a theme', async () => {
    await handleEditorialThemes(makeArgs({
      positionalArgs: ['create', 'Test'], tickers: 'btc-100k,us-recession-2027,epl-2027-champion',
    }));
    const show = await handleEditorialThemes(makeArgs({ positionalArgs: ['show', 'Test'] }));
    expect(show.ok).toBe(true);
    if (!show.ok) return;
    if (show.data.kind !== 'show') throw new Error();
    expect(show.data.theme.series).toEqual(['btc-100k', 'epl-2027-champion', 'us-recession-2027']);
  });

  test('series keys normalize to lowercase, so slugs survive a round trip', async () => {
    await handleEditorialThemes(makeArgs({ positionalArgs: ['create', 'Case'], tickers: 'Fed-Decision-In-September' }));
    const show = await handleEditorialThemes(makeArgs({ positionalArgs: ['show', 'Case'] }));
    expect(show.ok).toBe(true);
    if (!show.ok || show.data.kind !== 'show') throw new Error();
    expect(show.data.theme.series).toEqual(['fed-decision-in-september']);
  });

  test('add-series and remove-series', async () => {
    await handleEditorialThemes(makeArgs({ positionalArgs: ['create', 'T'] }));
    const add = await handleEditorialThemes(makeArgs({ positionalArgs: ['add-series', 'T', 'btc-100k,us-recession-2027'] }));
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    if (add.data.kind !== 'mutation') throw new Error();
    expect(add.data.affected).toBe(2);

    const remove = await handleEditorialThemes(makeArgs({ positionalArgs: ['remove-series', 'T', 'btc-100k'] }));
    expect(remove.ok).toBe(true);
    if (!remove.ok) return;
    if (remove.data.kind !== 'mutation') throw new Error();
    expect(remove.data.affected).toBe(1);
  });

  test('overlap detects cross-theme series', async () => {
    await handleEditorialThemes(makeArgs({ positionalArgs: ['create', 'A'], tickers: 'btc-100k,us-recession-2027' }));
    await handleEditorialThemes(makeArgs({ positionalArgs: ['create', 'B'], tickers: 'us-recession-2027,epl-2027-champion' }));
    const overlap = await handleEditorialThemes(makeArgs({ positionalArgs: ['overlap'] }));
    expect(overlap.ok).toBe(true);
    if (!overlap.ok) return;
    if (overlap.data.kind !== 'overlap') throw new Error();
    expect(overlap.data.data).toHaveLength(1);
    expect(overlap.data.data[0]).toEqual({ series_ticker: 'us-recession-2027', themes: ['A', 'B'] });
  });

  test('import requires an explicit path — no seed file ships', async () => {
    const resp = await handleEditorialThemes(makeArgs({ positionalArgs: ['import'] }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('MISSING_PATH');
  });

  test('import + export round-trips', async () => {
    const tmpFile = join(tmpdir(), `themes-${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify({
      themes: [
        { name: 'X', description: 'desc', search_volume: 1234, series: ['fed-decision-in-september', 'us-recession-2027'] },
      ],
    }));
    const importResp = await handleEditorialThemes(makeArgs({ positionalArgs: ['import', tmpFile] }));
    expect(importResp.ok).toBe(true);

    const showResp = await handleEditorialThemes(makeArgs({ positionalArgs: ['show', 'X'] }));
    if (!showResp.ok || showResp.data.kind !== 'show') throw new Error();
    expect(showResp.data.theme.series).toEqual(['fed-decision-in-september', 'us-recession-2027']);
    expect(showResp.data.theme.search_volume).toBe(1234);

    const exportFile = join(tmpdir(), `themes-export-${Date.now()}.json`);
    const exportResp = await handleEditorialThemes(makeArgs({ positionalArgs: ['export', exportFile] }));
    expect(exportResp.ok).toBe(true);

    const reimported = JSON.parse(readFileSync(exportFile, 'utf-8'));
    expect(reimported.themes[0].name).toBe('X');
    expect(reimported.themes[0].series).toEqual(['fed-decision-in-september', 'us-recession-2027']);

    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(exportFile); } catch {}
  });

  test('delete removes a theme', async () => {
    await handleEditorialThemes(makeArgs({ positionalArgs: ['create', 'Doomed'] }));
    const del = await handleEditorialThemes(makeArgs({ positionalArgs: ['delete', 'Doomed'] }));
    expect(del.ok).toBe(true);
    const list = await handleEditorialThemes(makeArgs({ positionalArgs: ['list'] }));
    if (!list.ok || list.data.kind !== 'list') throw new Error();
    expect(list.data.data).toHaveLength(0);
  });

  test('unknown subcommand returns error', async () => {
    const resp = await handleEditorialThemes(makeArgs({ positionalArgs: ['bogus'] }));
    expect(resp.ok).toBe(false);
    if (resp.ok) return;
    expect(resp.error?.code).toBe('UNKNOWN_SUB');
  });
});

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
