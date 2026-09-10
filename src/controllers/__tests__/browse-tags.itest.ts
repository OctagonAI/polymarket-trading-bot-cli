/**
 * Integration test: verify that series tags are stored in the event index
 * and that subcategory searches (e.g. elections:primaries) match against them.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { ensureIndex } from '../../tools/polymarket/search-index.js';
import { getDb } from '../../db/index.js';

// Force a fresh index rebuild by clearing last_refresh
beforeAll(async () => {
  const db = getDb();
  db.exec(`DELETE FROM event_index_meta WHERE key = 'last_refresh'`);
  await ensureIndex();
}, 120_000); // allow up to 2 minutes for full index refresh

describe('browse subcategory tags', () => {
  test('event_index has tags column populated for at least some rows', () => {
    const db = getDb();
    const rows = db.query(
      `SELECT COUNT(*) as cnt FROM event_index WHERE tags IS NOT NULL AND tags != ''`,
    ).get() as { cnt: number };
    console.log(`Events with tags: ${rows.cnt}`);
    expect(rows.cnt).toBeGreaterThan(0);
  });

  test('searching for "primaries" in Elections category finds events via tags', () => {
    const db = getDb();
    const term = '%primaries%';
    const rows = db.query(
      `SELECT event_ticker, title, tags FROM event_index
       WHERE category = 'Elections' AND LOWER(COALESCE(tags,'')) LIKE ?
       LIMIT 10`,
    ).all(term) as Array<{ event_ticker: string; title: string; tags: string }>;
    console.log(`Elections events matching "primaries" tag:`);
    for (const r of rows) {
      console.log(`  ${r.event_ticker}: ${r.title} [tags: ${r.tags}]`);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  test('KXSENATETXR event is found via primaries tag search', () => {
    const db = getDb();
    const term = '%primaries%';
    const rows = db.query(
      `SELECT event_ticker, title, tags FROM event_index
       WHERE category = 'Elections' AND LOWER(COALESCE(tags,'')) LIKE ?`,
    ).all(term) as Array<{ event_ticker: string; title: string; tags: string }>;
    const tickers = rows.map((r) => r.event_ticker);
    // The event ticker might have a date suffix, so check with startsWith
    const found = tickers.some((t) => t.startsWith('KXSENATETXR'));
    if (!found) {
      console.log('Available election tickers with primaries tag:', tickers);
    }
    expect(found).toBe(true);
  });
});
