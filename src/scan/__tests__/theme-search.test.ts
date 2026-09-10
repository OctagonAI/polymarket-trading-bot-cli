import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  THEMES,
  META_CATEGORIES,
  findTheme,
  isThemeId,
  allThemeIds,
} from '../theme-registry.js';
import { searchOctagonEvents } from '../octagon-api.js';
import {
  clearAndPopulateIndex,
  countIndexedEvents,
  getLastRefresh,
  setLastRefresh,
} from '../../db/event-index.js';
import { createDb } from '../../db/index.js';

describe('theme registry', () => {
  test('every metaCategory is one of Octagon’s canonical eleven, exactly cased', () => {
    // The filter is case-sensitive and returns an EMPTY RESULT rather than an
    // error for an unknown value, so a typo here shows up as "no markets found"
    // instead of a failure. Pin the strings.
    for (const theme of THEMES) {
      expect(META_CATEGORIES).toContain(theme.metaCategory);
    }
  });

  test('every canonical category is reachable through some theme', () => {
    const covered = new Set(THEMES.map((t) => t.metaCategory));
    for (const category of META_CATEGORIES) {
      expect(covered).toContain(category);
    }
  });

  test('theme ids are lowercase and unique', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBe(id.toLowerCase());
  });

  test('every theme carries at least one Gamma tag for the local index', () => {
    for (const theme of THEMES) {
      expect(theme.tags.length).toBeGreaterThan(0);
    }
  });

  test('legacy ids still resolve, to their canonical theme', () => {
    expect(findTheme('entertainment')?.id).toBe('culture');
    expect(findTheme('social')?.id).toBe('culture');
    expect(findTheme('companies')?.id).toBe('finance');
    expect(findTheme('financials')?.id).toBe('finance');
    expect(findTheme('science')?.id).toBe('tech-science');
    expect(findTheme('world')?.id).toBe('politics');
  });

  test('lookup tolerates case and surrounding space, free text stays free text', () => {
    expect(findTheme('  Crypto ')?.id).toBe('crypto');
    expect(findTheme('government shutdown')).toBeUndefined();
    expect(isThemeId('top50')).toBe(true);
    expect(isThemeId('bitcoin')).toBe(false);
  });

  test('autocomplete offers top50 plus every id and alias', () => {
    const ids = allThemeIds();
    expect(ids).toContain('top50');
    expect(ids).toContain('tech-science');
    expect(ids).toContain('commodities');
    expect(ids).toContain('entertainment');
  });
});

describe('searchOctagonEvents param handling', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // request() rejects before it ever calls fetch when this is unset, so the
    // mock below would never be reached. A placeholder also SHADOWS a real key
    // that Bun auto-loads from .env — no test should be able to reach a live
    // endpoint with a live credential just because a mock had a gap.
    process.env.OCTAGON_API_KEY = 'sk_test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OCTAGON_API_KEY;
  });

  function captureUrl(): { url: () => string } {
    let seen = '';
    globalThis.fetch = (async (url: string) => {
      seen = String(url);
      return new Response('{"data":[],"next_cursor":null,"has_more":false}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { url: () => seen };
  }

  test('drops params the endpoint does not know', async () => {
    // /markets/events/search answers an unrecognised key with zero rows rather
    // than an error, so forwarding sort_by or min_volume_24h silently empties
    // the result set. They must never reach the wire.
    const cap = captureUrl();
    await searchOctagonEvents({
      q: 'shutdown',
      sort_by: 'volume_24h',
      min_volume_24h: 1000,
      close_before: '2026-12-31',
    } as Parameters<typeof searchOctagonEvents>[0]);

    const url = cap.url();
    expect(url).toContain('q=shutdown');
    expect(url).not.toContain('sort_by');
    expect(url).not.toContain('min_volume_24h');
    expect(url).not.toContain('close_before');
  });

  test('always scopes to Polymarket and passes meta_category through verbatim', async () => {
    const cap = captureUrl();
    await searchOctagonEvents({ meta_category: 'Tech & Science', limit: 30 });

    const url = new URL(cap.url());
    expect(url.searchParams.get('venues')).toBe('polymarket');
    // Encoding must survive the ampersand and the space.
    expect(url.searchParams.get('meta_category')).toBe('Tech & Science');
    expect(url.searchParams.get('limit')).toBe('30');
  });
});

describe('event index refresh safety', () => {
  let db: Database;

  const sample = [
    { event_ticker: 'a-real-event', title: 'A Real Event', category: 'Crypto', tags: ['Crypto'] },
  ];

  beforeEach(() => {
    db = createDb(':memory:');
  });

  test('an empty fetch does not wipe a good index', () => {
    // A transient empty response used to DELETE every row and then stamp the
    // refresh as successful, so every search returned nothing until the index
    // went stale two hours later.
    clearAndPopulateIndex(db, sample);
    expect(countIndexedEvents(db)).toBe(1);

    expect(() => clearAndPopulateIndex(db, [])).toThrow(/empty result set/);
    expect(countIndexedEvents(db)).toBe(1);
  });

  test('a zero-row index reads as empty however fresh its timestamp', () => {
    setLastRefresh(db, Date.now());
    expect(getLastRefresh(db)).not.toBeNull();
    // ensureIndex keys off this, not off the timestamp — a fresh stamp over an
    // empty table must not count as a usable index.
    expect(countIndexedEvents(db)).toBe(0);
  });
});
