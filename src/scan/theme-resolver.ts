import type { Database } from 'bun:sqlite';
import type { AuditTrail } from '../audit/trail.js';
import { fetchAllMarkets } from '../tools/polymarket/markets.js';
import { ensureIndex, getRefreshPromise } from '../tools/polymarket/search-index.js';
import { upsertEvent, deactivateExpired } from '../db/events.js';
import { getThemeTickers } from '../db/themes.js';

/**
 * Maps lowercase theme IDs to Polymarket tag labels, matched against the
 * `category` and `tags` columns of the local event index.
 *
 * Polymarket has no fixed category taxonomy the way Kalshi did — it has free-form
 * tags — so these are best-effort groupings.
 *
 * Deliberately NOT switched to Octagon's `meta_category`: that field only exists
 * on the few hundred events Octagon has scored, and collapses to a handful of
 * labels (Crypto / Politics / Sports / …). Resolving themes against the local
 * Gamma index covers the whole active universe at a finer grain, so Octagon is
 * the wrong source here even though it is the right source for edge and reports.
 */
export const CATEGORY_MAP: Record<string, string> = {
  'climate': 'Climate',
  'companies': 'Business',
  'crypto': 'Crypto',
  'economics': 'Economy',
  'elections': 'Elections',
  'entertainment': 'Pop Culture',
  'financials': 'Business',
  'health': 'Health',
  'mentions': 'Mentions',
  'politics': 'Politics',
  'science': 'Science',
  'social': 'Pop Culture',
  'sports': 'Sports',
  'transportation': 'Transportation',
  'world': 'Geopolitics',
};

/**
 * Build a map of category → sorted subcategory tags from the local event index.
 * Gamma has no endpoint that returns the tag taxonomy, so it is derived from the
 * tags already stored on indexed events.
 */
export async function fetchSubcategories(): Promise<Record<string, string[]>> {
  const { getDb } = await import('../db/index.js');
  await ensureIndex();
  const pending = getRefreshPromise();
  if (pending) await pending;

  const rows = getDb()
    .query(`SELECT category, tags FROM event_index WHERE tags IS NOT NULL AND tags != ''`)
    .all() as Array<{ category: string | null; tags: string | null }>;

  const allSeries = rows.map((r) => ({ category: r.category ?? '', tags: (r.tags ?? '').split(',').filter(Boolean) }));
  const catTags: Record<string, Set<string>> = {};

  for (const s of allSeries) {
    const cat = s.category;
    if (!cat) continue;
    if (!catTags[cat]) catTags[cat] = new Set();
    for (const tag of s.tags ?? []) {
      catTags[cat].add(tag);
    }
  }

  const result: Record<string, string[]> = {};
  for (const [cat, tags] of Object.entries(catTags)) {
    result[cat] = [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  return result;
}

export class ThemeResolver {
  private db: Database;
  private audit: AuditTrail;

  constructor(db: Database, audit: AuditTrail) {
    this.db = db;
    this.audit = audit;
  }

  async resolve(themeName: string): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000);
    let eventTickers: string[];

    if (themeName === 'top50') {
      eventTickers = await this.resolveTop50();
    } else if (themeName.includes(':')) {
      // Subcategory filter: "crypto:btc", "sports:football"
      eventTickers = await this.resolveSubcategory(themeName);
    } else if (CATEGORY_MAP[themeName]) {
      eventTickers = await this.resolveCategory(themeName);
    } else {
      eventTickers = getThemeTickers(this.db, themeName);
    }

    // Upsert resolved events
    for (const ticker of eventTickers) {
      upsertEvent(this.db, { ticker, active: 1, updated_at: now });
    }

    // Deactivate expired events
    deactivateExpired(this.db, now);

    // Audit log
    this.audit.log({
      type: 'SCAN_START',
      theme: themeName,
      events_count: eventTickers.length,
    });

    return eventTickers;
  }

  private async resolveTop50(): Promise<string[]> {
    const markets = await fetchAllMarkets({ closed: false, order: 'volume24hr', ascending: false }, 3);

    // Sort by volume_24h descending
    markets.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));

    // Take top 50 unique event tickers
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of markets) {
      if (!seen.has(m.event_ticker)) {
        seen.add(m.event_ticker);
        result.push(m.event_ticker);
        if (result.length >= 50) break;
      }
    }
    return result;
  }

  private async resolveCategory(themeName: string): Promise<string[]> {
    const categoryLabel = CATEGORY_MAP[themeName];
    // Gamma has no server-side category filter, so query the local SQLite index
    // instead of paging every open event
    await ensureIndex();
    // If ensureIndex kicked off a background refresh (first run / empty index),
    // await it so we don't query an unpopulated event_index table
    const pending = getRefreshPromise();
    if (pending) await pending;
    const rows = this.db.query(
      `SELECT event_ticker FROM event_index WHERE category = ?`,
    ).all(categoryLabel) as { event_ticker: string }[];
    return rows.map((r) => r.event_ticker);
  }

  private async resolveSubcategory(themeName: string): Promise<string[]> {
    const [catKey, ...subParts] = themeName.split(':');
    const subTag = subParts.join(':').toLowerCase();
    const categoryLabel = CATEGORY_MAP[catKey];
    if (!categoryLabel) return [];

    await ensureIndex();
    const pending = getRefreshPromise();
    if (pending) await pending;

    // Tags are stored comma-joined on the index row; match either the raw label
    // or its kebab-cased form so "pop-culture" and "Pop Culture" both resolve.
    const rows = this.db
      .query(`SELECT event_ticker, tags FROM event_index WHERE category = ?`)
      .all(categoryLabel) as Array<{ event_ticker: string; tags: string | null }>;

    const seen = new Set<string>();
    const eventTickers: string[] = [];
    for (const row of rows) {
      const tags = (row.tags ?? '').split(',').filter(Boolean);
      const hasTag = tags.some((t) => {
        const tagLower = t.toLowerCase();
        const tagKebab = tagLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return tagLower === subTag || tagKebab === subTag;
      });
      if (hasTag && !seen.has(row.event_ticker)) {
        seen.add(row.event_ticker);
        eventTickers.push(row.event_ticker);
      }
    }

    return eventTickers;
  }
}
