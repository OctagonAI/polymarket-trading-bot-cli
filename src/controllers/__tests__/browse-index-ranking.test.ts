import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { PolymarketMarket } from '../../tools/polymarket/types.js';
import { createDb } from '../../db/index.js';
import { upsertIndexEvents } from '../../db/event-index.js';
import { selectIndexEventTickers } from '../browse.js';

interface Seed {
  ticker: string;
  title: string;
  category?: string;
  tags?: string[];
  volume?: number;
  status?: string;
  closeTime?: string;
  series?: string;
}

function seed(db: Database, rows: Seed[]): void {
  upsertIndexEvents(
    db,
    rows.map((r) => ({
      event_ticker: r.ticker,
      title: r.title,
      series_ticker: r.series ?? 'test-series',
      category: r.category,
      tags: r.tags,
      markets: [
        {
          ticker: `${r.ticker}-m1`,
          title: r.title,
          yes_sub_title: 'Yes',
          status: r.status ?? 'active',
          close_time: r.closeTime ?? '2099-01-01T00:00:00Z',
          result: '',
          volume: r.volume ?? 100,
        } as unknown as PolymarketMarket,
      ],
    })),
  );
}

describe('selectIndexEventTickers', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('the cap keeps the busiest events, not an arbitrary slice', () => {
    // The regression this guards: the LIMIT used to run with no ORDER BY, so
    // the volume sort that followed could only reorder whichever rows SQLite
    // happened to hand back. Seeded in ascending volume so insertion order is
    // the opposite of the expected answer.
    seed(
      db,
      Array.from({ length: 10 }, (_, i) => ({
        ticker: `ev-${i}`,
        title: `crypto event ${i}`,
        category: 'Crypto',
        tags: ['Crypto'],
        volume: (i + 1) * 100,
      })),
    );

    expect(selectIndexEventTickers(db, '', ['Crypto'], 3)).toEqual(['ev-9', 'ev-8', 'ev-7']);
  });

  test('ranks a category-plus-term search too', () => {
    seed(db, [
      { ticker: 'btc-small', title: 'bitcoin small', category: 'Crypto', tags: ['Crypto'], volume: 5 },
      { ticker: 'btc-big', title: 'bitcoin big', category: 'Crypto', tags: ['Crypto'], volume: 9000 },
      { ticker: 'eth-big', title: 'ethereum big', category: 'Crypto', tags: ['Crypto'], volume: 9999 },
    ]);

    expect(selectIndexEventTickers(db, 'bitcoin', ['Crypto'], 30)).toEqual(['btc-big', 'btc-small']);
  });

  test('ranks a free-text search', () => {
    seed(db, [
      { ticker: 'quiet', title: 'election quiet', volume: 10 },
      { ticker: 'loud', title: 'election loud', volume: 5000 },
    ]);

    expect(selectIndexEventTickers(db, 'election', null, 30)).toEqual(['loud', 'quiet']);
  });

  test('events with no open market never consume a cap slot', () => {
    seed(db, [
      { ticker: 'resolved', title: 'crypto resolved', category: 'Crypto', tags: ['Crypto'], volume: 99999, status: 'closed' },
      { ticker: 'expired', title: 'crypto expired', category: 'Crypto', tags: ['Crypto'], volume: 88888, closeTime: '2020-01-01T00:00:00Z' },
      { ticker: 'live', title: 'crypto live', category: 'Crypto', tags: ['Crypto'], volume: 1 },
    ]);

    // Both untradeable events out-volume the live one, so ranking alone would
    // put them first; the open-market filter is what keeps them out entirely.
    expect(selectIndexEventTickers(db, '', ['Crypto'], 30)).toEqual(['live']);
  });

  test('an exact series ticker still wins over the free-text fallback', () => {
    seed(db, [
      { ticker: 'exact', title: 'something else', series: 'KXBTC', volume: 10 },
      { ticker: 'mention', title: 'a KXBTC mention', series: 'other', volume: 9999 },
    ]);

    expect(selectIndexEventTickers(db, 'KXBTC', null, 30)).toEqual(['exact']);
  });

  test('a label matches a whole tag but not a partial one', () => {
    seed(db, [
      { ticker: 'exact-tag', title: 'a', category: 'x', tags: ['Crypto'], volume: 10 },
      { ticker: 'partial-tag', title: 'b', category: 'x', tags: ['Crypto Prices'], volume: 9999 },
    ]);

    expect(selectIndexEventTickers(db, '', ['Crypto'], 30)).toEqual(['exact-tag']);
  });
});
