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
          result: '',
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
