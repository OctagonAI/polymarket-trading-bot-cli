import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { PolymarketMarket } from '../../tools/polymarket/types.js';
import { createDb } from '../index.js';
import { searchEventIndex, upsertIndexEvents } from '../event-index.js';

interface Seed {
  ticker: string;
  title: string;
  category?: string;
  tags?: string[];
  volume?: number;
  closed?: boolean;
  result?: string;
}

function seed(db: Database, rows: Seed[]): void {
  upsertIndexEvents(
    db,
    rows.map((r) => ({
      event_ticker: r.ticker,
      title: r.title,
      series_ticker: 'test-series',
      category: r.category,
      tags: r.tags,
      markets: [
        {
          ticker: `${r.ticker}-m1`,
          title: r.title,
          yes_sub_title: 'Yes',
          status: r.closed ? 'closed' : 'active',
          close_time: '2099-01-01T00:00:00Z',
          result: r.result ?? '',
          volume: r.volume ?? 100,
        } as unknown as PolymarketMarket,
      ],
    })),
  );
}

describe('searchEventIndex categoryLabels', () => {
  let db: Database;
  beforeEach(() => { db = createDb(':memory:'); });
  afterEach(() => { db.close(); });

  test('a bare theme searches by category with no keyword', () => {
    // The regression this guards: the CLI passed `crypto:btc` as one keyword and
    // matched nothing, while the TUI filtered by category and searched within it.
    seed(db, [
      { ticker: 'btc-100k', title: 'Bitcoin above 100k', tags: ['Crypto'] },
      { ticker: 'senate-control', title: 'Senate control', tags: ['Politics'] },
    ]);
    const rows = searchEventIndex(db, '', 50, { categoryLabels: ['Crypto'] });
    expect(rows.map((r) => r.event_ticker)).toEqual(['btc-100k']);
  });

  test('a subtheme narrows within the category and does not escape it', () => {
    seed(db, [
      { ticker: 'btc-100k', title: 'Bitcoin above 100k', tags: ['Crypto'] },
      { ticker: 'eth-5k', title: 'Ethereum above 5k', tags: ['Crypto'] },
      { ticker: 'btc-ban', title: 'Bitcoin ban passes', tags: ['Politics'] },
    ]);
    const rows = searchEventIndex(db, 'bitcoin', 50, { categoryLabels: ['Crypto'] });
    expect(rows.map((r) => r.event_ticker)).toEqual(['btc-100k']);
  });

  test('a label matches the category column as well as a whole tag', () => {
    seed(db, [{ ticker: 'cat-only', title: 'Category only', category: 'Crypto' }]);
    expect(searchEventIndex(db, '', 50, { categoryLabels: ['Crypto'] }).map((r) => r.event_ticker))
      .toEqual(['cat-only']);
  });

  test('a label does not match a longer tag that merely starts with it', () => {
    // Comma-wrapping is what stops "Crypto" hitting "Crypto Prices".
    seed(db, [{ ticker: 'partial', title: 'Partial tag', category: 'Other', tags: ['Crypto Prices'] }]);
    expect(searchEventIndex(db, '', 50, { categoryLabels: ['Crypto'] })).toHaveLength(0);
  });

  test('neither keyword nor label is still an empty query', () => {
    seed(db, [{ ticker: 'btc-100k', title: 'Bitcoin above 100k', tags: ['Crypto'] }]);
    expect(searchEventIndex(db, '', 50)).toHaveLength(0);
    expect(searchEventIndex(db, '', 50, { categoryLabels: [] })).toHaveLength(0);
  });

  test('the active-market filter still applies when labels are supplied', () => {
    seed(db, [
      { ticker: 'live', title: 'Live crypto event', tags: ['Crypto'] },
      { ticker: 'dead', title: 'Closed crypto event', tags: ['Crypto'], closed: true },
    ]);
    expect(searchEventIndex(db, '', 50, { categoryLabels: ['Crypto'] }).map((r) => r.event_ticker))
      .toEqual(['live']);
  });

  test('volume ordering still applies when labels are supplied', () => {
    seed(db, [
      { ticker: 'quiet', title: 'Quiet crypto event', tags: ['Crypto'], volume: 10 },
      { ticker: 'busy', title: 'Busy crypto event', tags: ['Crypto'], volume: 9000 },
    ]);
    expect(searchEventIndex(db, '', 50, { categoryLabels: ['Crypto'] }).map((r) => r.event_ticker))
      .toEqual(['busy', 'quiet']);
  });
});

describe('searchEventIndex tradeable predicate', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('an event whose only market has settled is not returned', () => {
    // status alone does not mean tradeable: a market can settle upstream while
    // the index still carries status 'active'.
    seed(db, [
      { ticker: 'settled', title: 'crypto settled', category: 'Crypto', tags: ['Crypto'], result: 'yes' },
      { ticker: 'live', title: 'crypto live', category: 'Crypto', tags: ['Crypto'] },
    ]);

    const got = searchEventIndex(db, '', 30, { categoryLabels: ['Crypto'] });
    expect(got.map((e) => e.event_ticker)).toEqual(['live']);
  });

  test('a settled market contributes no volume to the ranking', () => {
    // The filter and the ranking have to agree, or a settled market keeps
    // pushing its event up the list after it stops being tradeable.
    seed(db, [
      { ticker: 'mixed', title: 'crypto mixed', category: 'Crypto', tags: ['Crypto'], volume: 10 },
      { ticker: 'busy', title: 'crypto busy', category: 'Crypto', tags: ['Crypto'], volume: 500 },
    ]);
    // Give 'mixed' a second, settled market worth far more than 'busy'.
    const row = db
      .query('SELECT markets_json FROM event_index WHERE event_ticker = ?')
      .get('mixed') as { markets_json: string };
    const markets = JSON.parse(row.markets_json);
    markets.push({ ...markets[0], ticker: 'mixed-m2', result: 'yes', volume: 999999 });
    db.query('UPDATE event_index SET markets_json = ? WHERE event_ticker = ?').run(
      JSON.stringify(markets),
      'mixed',
    );

    const got = searchEventIndex(db, '', 30, { categoryLabels: ['Crypto'] });
    expect(got.map((e) => e.event_ticker)).toEqual(['busy', 'mixed']);
  });
});
