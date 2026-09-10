import type { Database } from 'bun:sqlite';
import type { AuditTrail } from '../audit/trail.js';
import { fetchAllMarkets } from '../tools/polymarket/markets.js';
import { ensureIndex, getRefreshPromise } from '../tools/polymarket/search-index.js';
import { upsertEvent, deactivateExpired } from '../db/events.js';
import { getThemeTickers } from '../db/themes.js';
import { findTheme, themeTagLabels } from './theme-registry.js';

/**
 * Theme id → Polymarket tag labels, matched against the `category` and `tags`
 * columns of the local event index.
 *
 * Derived from the shared registry in theme-registry.ts so the ids a user sees
 * are the same ones `search` accepts. A theme can carry several tag labels
 * because Gamma splits some of Octagon's categories — "Tech & Science" is two
 * separate Gamma tags, and Octagon's "Climate" is tagged "Weather" here.
 *
 * Deliberately NOT using Octagon's `meta_category` for this path: resolving
 * against the local Gamma index covers the whole active universe at a finer
 * grain and needs no API key. `search` uses meta_category because it queries
 * Octagon directly; that split is why registry entries carry both.
 */
export const CATEGORY_MAP: Record<string, string[]> = themeTagLabels();

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
  const catTags: Record<string, Map<string, number>> = {};

  for (const s of allSeries) {
    const cat = s.category;
    if (!cat) continue;
    if (!catTags[cat]) catTags[cat] = new Map();
    for (const tag of s.tags ?? []) {
      catTags[cat].set(tag, (catTags[cat].get(tag) ?? 0) + 1);
    }
  }

  // Ranked by how many events carry the tag, not alphabetically. Polymarket
  // tags are free-form and long-tailed — a single category can carry 170+ of
  // them, most matching one event and some being artefacts ("Rewards 20, 4.5,
  // 50") — so an A-Z list buries the tags anyone would actually browse.
  const result: Record<string, string[]> = {};
  for (const [cat, tags] of Object.entries(catTags)) {
    result[cat] = [...tags.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .map(([tag]) => tag);
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
    } else if (findTheme(themeName)) {
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
    const labels = findTheme(themeName)?.tags ?? [];
    if (labels.length === 0) return [];
    // Gamma has no server-side category filter, so query the local SQLite index
    // instead of paging every open event
    await ensureIndex();
    // If ensureIndex kicked off a background refresh (first run / empty index),
    // await it so we don't query an unpopulated event_index table
    const pending = getRefreshPromise();
    if (pending) await pending;
    // `category` holds tags[0], which is often a narrow label ("Bitcoin",
    // "Price Milestone") rather than the broad one, so matching it alone drops
    // most of a category. Also match the label as a whole tag: wrapping both
    // sides in commas makes this exact-token, so "Crypto" does not match on
    // "Crypto Prices" by accident (SQLite LIKE is ASCII case-insensitive).
    const seen = new Set<string>();
    for (const label of labels) {
      const rows = this.db.query(
        `SELECT event_ticker FROM event_index
          WHERE category = ?1 OR ',' || COALESCE(tags, '') || ',' LIKE ?2`,
      ).all(label, `%,${label},%`) as { event_ticker: string }[];
      for (const row of rows) seen.add(row.event_ticker);
    }
    return [...seen];
  }

  private async resolveSubcategory(themeName: string): Promise<string[]> {
    const [catKey, ...subParts] = themeName.split(':');
    const subTag = subParts.join(':').toLowerCase();
    const labels = findTheme(catKey ?? '')?.tags ?? [];
    if (labels.length === 0) return [];

    await ensureIndex();
    const pending = getRefreshPromise();
    if (pending) await pending;

    // Tags are stored comma-joined on the index row; match either the raw label
    // or its kebab-cased form so "pop-culture" and "Pop Culture" both resolve.
    const rows: Array<{ event_ticker: string; tags: string | null }> = [];
    for (const label of labels) {
      rows.push(
        ...(this.db
          .query(
            `SELECT event_ticker, tags FROM event_index
              WHERE category = ?1 OR ',' || COALESCE(tags, '') || ',' LIKE ?2`,
          )
          .all(label, `%,${label},%`) as Array<{ event_ticker: string; tags: string | null }>),
      );
    }

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
