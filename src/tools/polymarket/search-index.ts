import { getDb } from '../../db/index.js';
import { clearAndPopulateIndex, getIndexAge, setLastRefresh } from '../../db/event-index.js';
import { fetchAllEvents } from './events.js';
import { logger } from '../../utils/logger.js';

/** Stale threshold: triggers background refresh */
const INDEX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Singleton promise to prevent concurrent refreshes */
let _refreshPromise: Promise<void> | null = null;

/** How many pages of 100 events to pull. Polymarket has ~10k open markets. */
const MAX_INDEX_PAGES = 20;

// --- Progress observable ---

export type IndexProgressPhase = 'fetching_events' | 'fetching_series' | 'populating';

export interface IndexProgressInfo {
  phase: IndexProgressPhase;
  fetchedItems: number;
  page: number;
  maxPages: number;
  detail?: string;
}

export type IndexProgressListener = (info: IndexProgressInfo) => void;

const _progressListeners = new Set<IndexProgressListener>();

/** Subscribe to index refresh progress. Returns an unsubscribe function. */
export function onIndexProgress(listener: IndexProgressListener): () => void {
  _progressListeners.add(listener);
  return () => { _progressListeners.delete(listener); };
}

function emitProgress(info: IndexProgressInfo): void {
  for (const listener of _progressListeners) {
    try { listener(info); } catch { /* ignore listener errors */ }
  }
}

/** Get the current refresh promise so callers can await it if desired. */
export function getRefreshPromise(): Promise<void> | null {
  return _refreshPromise;
}

/**
 * Rebuild the local event index from Gamma.
 *
 * Simpler than the Kalshi equivalent: Gamma's /events already nests both the
 * markets and the tags, so there is no second pass to fetch series tags.
 */
async function refreshIndex(): Promise<void> {
  const db = getDb();
  logger.info('[search-index] Refreshing event index from Polymarket Gamma API...');
  const start = Date.now();

  try {
    const events = await fetchAllEvents(
      { closed: false, order: 'volume24hr', ascending: false },
      MAX_INDEX_PAGES,
      (info) => {
        emitProgress({
          phase: 'fetching_events',
          fetchedItems: info.fetchedItems,
          page: info.page,
          maxPages: info.maxPages,
        });
      }
    );

    emitProgress({
      phase: 'populating',
      fetchedItems: events.length,
      page: 0,
      maxPages: 0,
      detail: `Writing ${events.length} events to index...`,
    });

    clearAndPopulateIndex(
      db,
      events.map((e) => ({
        event_ticker: e.event_ticker,
        series_ticker: e.series_ticker ?? '',
        title: e.title,
        category: e.category,
        strike_date: e.strike_date,
        sub_title: e.sub_title,
        markets: e.markets,
        tags: e.tags,
      })),
    );

    setLastRefresh(db, Date.now());

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`[search-index] Index refreshed: ${events.length} events in ${elapsed}s`);
  } catch (error) {
    logger.error('[search-index] Failed to refresh index:', error);
    throw error;
  }
}

/**
 * Force an immediate index rebuild, bypassing the 2-hour stale check.
 * If a refresh is already in progress, waits for it to complete first,
 * then starts a new one.
 */
export async function forceRefreshIndex(): Promise<void> {
  if (_refreshPromise) {
    await _refreshPromise;
  }
  _refreshPromise = refreshIndex().finally(() => {
    _refreshPromise = null;
  });
  await _refreshPromise;
}

/**
 * Ensure the local event index is fresh. If stale or empty, triggers a refresh.
 * Always returns immediately (never blocks).
 */
export async function ensureIndex(): Promise<void> {
  const db = getDb();
  const age = getIndexAge(db);

  if (age < INDEX_STALE_MS) return;

  if (!_refreshPromise) {
    _refreshPromise = refreshIndex()
      .catch((err) => {
        logger.error('[search-index] Background refresh failed:', err);
      })
      .finally(() => {
        _refreshPromise = null;
      });
  }
}
