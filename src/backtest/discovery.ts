import type { Database } from 'bun:sqlite';
import { fetchEventBySlug } from '../tools/polymarket/events.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';
import { fetchAllOctagonEvents } from '../scan/octagon-events-api.js';

const CONCURRENCY = 10;

/** Where the backtest universe is sourced from. */
export type UniverseSource = 'api' | 'local';

export interface UniverseEntry {
  event_ticker: string;
  category: string | null;
}

export interface Universe {
  events: UniverseEntry[];
  source: UniverseSource;
  description: string;
}

/**
 * Resolve the backtest universe (the set of events scored).
 *
 * `api` (default): paginate Octagon's covered-events list — systematic,
 * reproducible across machines, doesn't depend on whatever this install
 * happened to analyze in the past. Uses fetchAllOctagonEvents directly;
 * we deliberately do NOT pass hasHistory=true because a prior audit showed
 * that flag silently dropped 373 of 662 events. The pipeline self-filters
 * downstream: events with no usable snapshot return null from
 * selectSnapshotByDate and are skipped cheaply.
 *
 * `local`: legacy behavior — pull from the local `octagon_reports` log.
 * Reflects past usage of this machine, not a defined universe. Useful for
 * offline runs and for comparing against historical backtests.
 *
 * KNOWN LIMITATION: the API returns *today's* covered universe, not the
 * universe as of the entry date. Events dropped from coverage mid-window
 * vanish from the backtest — survivorship at the universe level. A true
 * point-in-time universe requires `events?as_of=<date>` upstream.
 */
export async function resolveUniverse(
  db: Database,
  opts?: { source?: UniverseSource; category?: string },
): Promise<Universe> {
  const source = opts?.source ?? 'api';
  if (source === 'api') {
    const all = await fetchAllOctagonEvents();
    let events: UniverseEntry[] = all.map((e) => ({
      event_ticker: e.event_ticker,
      category: e.series_category ?? null,
    }));
    if (opts?.category) {
      const needle = opts.category.toLowerCase();
      events = events.filter((e) => e.category?.toLowerCase().includes(needle));
    }
    return {
      events,
      source,
      description: `${events.length} events from Octagon API (systematic universe)`,
    };
  }
  // Legacy local path
  const { query, params } = buildEventQuery('', opts?.category);
  const rows = db.query(query).all(params) as Array<{ event_ticker: string; category: string | null }>;
  return {
    events: rows.map((r) => ({ event_ticker: r.event_ticker, category: r.category })),
    source,
    description: `${rows.length} events from local octagon_reports (NON-SYSTEMATIC — reflects past usage of this machine)`,
  };
}

/**
 * Fetch the Kalshi event payload for each event in the universe, once.
 * Returns a map keyed by event_ticker. Both discoverSettledMarkets and
 * discoverOpenMarkets can read from this single map instead of each
 * re-fetching every event payload — halves the Kalshi call count.
 */
export async function fetchEventPayloads(
  universe: UniverseEntry[],
): Promise<Map<string, PolymarketMarket[]>> {
  const out = new Map<string, PolymarketMarket[]>();
  await parallelMap(universe, async (entry) => {
    const markets = await fetchEventMarkets(entry.event_ticker);
    out.set(entry.event_ticker, markets);
  }, CONCURRENCY);
  return out;
}

export interface SettledMarket {
  ticker: string;
  event_ticker: string;
  result: 'yes' | 'no';
  close_time: string;
  series_category: string;
  last_price: number;         // last traded price (0-1)
  volume: number;             // lifetime trading volume (used for tradeability gate)
}

export interface OpenMarket {
  ticker: string;
  event_ticker: string;
  market_prob: number;        // current trading price (0-1)
  close_time: string;
  series_category: string;
  volume: number;             // lifetime trading volume (tradeability gate)
  volume_24h: number;         // 24-hour volume (liquidity-now gate)
}

/** Last traded price as a decimal probability (0-1). */
function parsePrice(m: PolymarketMarket): number {
  return Number.isFinite(m.last_price) ? m.last_price : 0;
}

/** Lifetime traded volume, USDC. */
function parseVolume(m: PolymarketMarket): number {
  return Number.isFinite(m.volume) ? m.volume : 0;
}

/** 24-hour traded volume, USDC. */
function parseVolume24h(m: PolymarketMarket): number {
  return Number.isFinite(m.volume_24h) ? m.volume_24h : 0;
}

/** Fetch event markets from Gamma, returning empty array on error. */
async function fetchEventMarkets(eventTicker: string): Promise<PolymarketMarket[]> {
  try {
    const event = await fetchEventBySlug(eventTicker);
    return event?.markets ?? [];
  } catch {
    return [];
  }
}

/** Build the event discovery query with optional category filter and extra WHERE clauses. */
function buildEventQuery(
  extraWhere: string,
  category?: string,
): { query: string; params: Record<string, string> } {
  let query = `SELECT event_ticker, MAX(series_category) as category
    FROM octagon_reports r WHERE variant_used = 'events-api'${extraWhere}`;
  const params: Record<string, string> = {};
  if (category) {
    query += ' AND LOWER(series_category) LIKE $cat';
    params.$cat = `%${category.toLowerCase()}%`;
  }
  query += ' GROUP BY event_ticker';
  return { query, params };
}

/** Process items in parallel batches of `concurrency`. */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Discover settled Kalshi markets that have Octagon coverage with history.
 *
 * No close_time filter: the backtest's prediction-age window is enforced
 * downstream via `selectSnapshotByDate`. Filtering on close_time here would
 * wrongly exclude events that closed before the lookback window but whose
 * predictions were still made within the prediction-age window (they'd still
 * have outcomes to score against).
 */
export async function discoverSettledMarkets(
  db: Database,
  opts?: {
    category?: string;
    /** Pre-resolved universe + payloads (Phase 4 path). When omitted, falls back to the legacy local SQL path. */
    universe?: Universe;
    payloads?: Map<string, PolymarketMarket[]>;
  },
): Promise<SettledMarket[]> {
  let events: Array<{ event_ticker: string; category: string | null }>;
  if (opts?.universe) {
    events = opts.universe.events;
  } else {
    const { query, params } = buildEventQuery('', opts?.category);
    events = db.query(query).all(params) as Array<{ event_ticker: string; category: string | null }>;
  }

  const batchResults = await parallelMap(events, async ({ event_ticker, category: cat }) => {
    const markets = opts?.payloads?.get(event_ticker) ?? await fetchEventMarkets(event_ticker);
    const settled: SettledMarket[] = [];

    for (const m of markets) {
      const result = (m.result ?? '').toLowerCase();
      if (result !== 'yes' && result !== 'no') continue;

      settled.push({
        ticker: m.ticker,
        event_ticker,
        result: result as 'yes' | 'no',
        close_time: m.close_time ?? '',
        series_category: cat ?? '',
        last_price: parsePrice(m),
        volume: parseVolume(m),
      });
    }
    return settled;
  }, CONCURRENCY);

  return batchResults.flat();
}

/**
 * Discover open Kalshi markets that have Octagon coverage.
 */
export async function discoverOpenMarkets(
  db: Database,
  opts?: {
    category?: string;
    universe?: Universe;
    payloads?: Map<string, PolymarketMarket[]>;
  },
): Promise<OpenMarket[]> {
  let events2: Array<{ event_ticker: string; category: string | null }>;
  if (opts?.universe) {
    events2 = opts.universe.events;
  } else {
    const { query: q2, params: p2 } = buildEventQuery('', opts?.category);
    events2 = db.query(q2).all(p2) as Array<{ event_ticker: string; category: string | null }>;
  }

  const batchResults = await parallelMap(events2, async ({ event_ticker, category: cat }) => {
    const markets = opts?.payloads?.get(event_ticker) ?? await fetchEventMarkets(event_ticker);
    const open: OpenMarket[] = [];

    for (const m of markets) {
      const status = (m.status ?? '').toLowerCase();
      if (status !== 'open' && status !== 'active') continue;

      const marketProb = parsePrice(m);
      if (marketProb <= 0) continue;

      open.push({
        ticker: m.ticker,
        event_ticker,
        market_prob: marketProb,
        close_time: m.close_time ?? '',
        series_category: cat ?? '',
        volume: parseVolume(m),
        volume_24h: parseVolume24h(m),
      });
    }
    return open;
  }, CONCURRENCY);

  return batchResults.flat();
}
