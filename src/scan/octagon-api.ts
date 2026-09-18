/**
 * Typed wrappers over Octagon's prediction-markets API.
 *
 * Every route here is venue-generic (`/markets/search`, `/markets/similar`,
 * `/markets/{venue}/{native_ticker}`), takes a `venues` filter and is scoped to
 * Polymarket. The `/predictions/kalshi/*` namespace is deliberately not called:
 * those routes have no venue-generic equivalent and answer with Kalshi data
 * whatever you send them, so the commands that used them were removed rather
 * than left to mislabel another venue's markets.
 *
 * The older /v1/prediction-markets/* prefix is deprecated; it still responds but
 * is Kalshi-shaped and ignores venue filters.
 *
 * Conventions:
 * - Fetch + Authorization: Bearer ${OCTAGON_API_KEY}
 * - 60s deadline per request, covering the body read (see utils/http.ts)
 * - Non-2xx → Error with status + body excerpt
 * - Market-row prices are DECIMALS (0-1), matching Polymarket's native units.
 *   Event-level probabilities in octagon-events-api.ts are percentages (0-100).
 *
 * All endpoints are stateless from the CLI's perspective — no SQLite caching.
 */

import { fetchAllOctagonEvents } from './octagon-events-api.js';
import { fetchWithDeadline, safeText } from '../utils/http.js';

const PREDICTIONS_BASE = 'https://api.octagonai.co/v1/predictions';

/** Octagon's venue filter value for every venue-generic call this CLI makes. */
export const OCTAGON_VENUE = 'polymarket';

const TIMEOUT_MS = 60_000;

/**
 * Venue-generic rows carry a namespaced ticker (`polymarket__<native>`) so that
 * ids stay unique across venues, while `native_ticker` holds the bare
 * Polymarket slug. Anything that leaves this module — a URL, a Gamma lookup, an
 * /events route — needs the bare form.
 */
export function stripVenuePrefix(ticker: string | null | undefined): string {
  if (!ticker) return '';
  const i = ticker.indexOf('__');
  return i === -1 ? ticker : ticker.slice(i + 2);
}

/**
 * Inverse of stripVenuePrefix. The /markets routes match `anchor_ticker` against
 * the namespaced id and return nothing for a bare slug, whereas the /events
 * routes require the bare form — so the prefix has to be applied per route
 * rather than carried around by callers.
 */
export function addVenuePrefix(ticker: string): string {
  return ticker.includes('__') ? ticker : `${OCTAGON_VENUE}__${ticker}`;
}

function buildQuery(params?: object): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  opts?: {
    params?: object;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const apiKey = process.env.OCTAGON_API_KEY;
  if (!apiKey) {
    throw new Error('OCTAGON_API_KEY not set. Get one at https://app.octagonai.co');
  }

  const url = `${base}${path}${method === 'GET' ? buildQuery(opts?.params) : ''}`;

  return fetchWithDeadline<T>(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' && opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    opts?.timeoutMs ?? TIMEOUT_MS,
    async (resp) => {
      if (!resp.ok) {
        const body = await safeText(resp);
        let detail = body.slice(0, 300);
        try {
          const parsed = JSON.parse(body) as { detail?: unknown };
          if (typeof parsed.detail === 'string') detail = parsed.detail;
        } catch {
          // body wasn't JSON — fall through with text excerpt
        }
        throw new Error(`Octagon API ${resp.status} (${method} ${path}): ${detail}`);
      }

      return (await resp.json()) as T;
    },
  );
}

/** Venue-generic routes; every call is scoped to Polymarket. */
function venueApi<T>(method: 'GET' | 'POST', path: string, opts?: { params?: object; body?: unknown; timeoutMs?: number }): Promise<T> {
  return request<T>(PREDICTIONS_BASE, method, path, opts);
}

// ─── Response shapes ────────────────────────────────────────────────────────

export interface OctagonMarketRow {
  /** Namespaced id: `polymarket__<native_ticker>`. Use stripVenuePrefix for the bare slug. */
  market_ticker: string;
  /** Bare Polymarket market slug. */
  native_ticker?: string | null;
  venue?: string | null;
  /** Namespaced event id: `polymarket__<event-slug>`. */
  event_ticker: string;
  series_ticker?: string | null;
  title: string;
  subtitle?: string | null;
  yes_subtitle?: string | null;
  no_subtitle?: string | null;
  status: string;
  close_time: string | null;
  last_price?: number | null;
  yes_bid?: number | null;
  yes_ask?: number | null;
  no_bid?: number | null;
  no_ask?: number | null;
  volume?: number | null;
  volume_24h?: number | null;
  liquidity?: number | null;
  open_interest?: number | null;
  category?: string | null;
  event_name?: string | null;
  /** Similarity distance; populated only by /markets/similar. */
  distance?: number | null;
}

/** @deprecated Kalshi-era name kept as an alias while callers migrate. */
export type KalshiMarketRow = OctagonMarketRow;

export interface PagedResult<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SimilarMarketRow extends OctagonMarketRow {
  distance: number;
}

export interface MarketsWithEdgeRow {
  event_ticker: string;
  market_ticker?: string | null;
  title: string;
  series_category: string | null;
  model_probability: number;   // 0-100 (live API returns percentage, not fraction)
  market_probability: number;  // 0-100
  edge_pp: number;             // already in percentage points
  expected_return: number;
  confidence_score: number;
  total_volume: number;
  total_open_interest: number;
  captured_at?: string;
}

export interface MarketsWithEdgeResponse {
  run_id: string;
  captured_at: string | null;
  sort_by: string;
  data: MarketsWithEdgeRow[];
  next_cursor: string | null;
  has_more: boolean;
}

// ─── Group A — Primitives ───────────────────────────────────────────────────

export interface SearchMarketsParams {
  q?: string;
  category?: string;
  series_ticker?: string;
  series_prefix?: string;
  event_ticker?: string;
  close_before?: string;
  min_volume_24h?: number;
  sort_by?: 'volume_24h' | 'close_time' | 'last_price';
  limit?: number;
  cursor?: string;
}

/**
 * Full-text market search across Polymarket.
 *
 * The venue-generic route is `/markets/search`, not the Kalshi namespace's
 * `/markets` — passing `venues` to the latter is silently ignored and yields
 * Kalshi rows.
 */
export function searchOctagonMarkets(params: SearchMarketsParams): Promise<PagedResult<OctagonMarketRow>> {
  return venueApi<PagedResult<OctagonMarketRow>>('GET', '/markets/search', {
    params: { ...params, venues: OCTAGON_VENUE },
  });
}

/**
 * A row from `/markets/events/search`. Shaped like a market row — same title,
 * price and volume fields — but describing an EVENT, so `close_time` is always
 * null and the useful slug is `native_event_ticker`.
 */
export interface OctagonEventSearchRow extends OctagonMarketRow {
  native_event_ticker?: string | null;
  has_report?: boolean | null;
}

export interface SearchEventsParams {
  q?: string;
  /** EXACT case — see META_CATEGORIES. A lowercase value returns zero rows. */
  meta_category?: string;
  report?: 'all' | 'ready' | 'none';
  limit?: number;
  cursor?: string;
}

/**
 * Every query key `/markets/events/search` accepts. Anything else must be
 * dropped rather than forwarded — see the warning on searchOctagonEvents.
 */
const EVENT_SEARCH_KEYS = ['q', 'meta_category', 'report', 'limit', 'cursor', 'venues'] as const;

/**
 * Event-level search across Polymarket.
 *
 * Prefer this over searchOctagonMarkets for anything a human typed. Polymarket
 * market titles are outcome labels ("Yes", "76,000", "Marine Le Pen") while the
 * subject lives on the event, so market-level full text misses the obvious
 * query: `q=government shutdown` returns 0 markets but 2 events.
 *
 * This is also the only route that reaches `meta_category`, Octagon's
 * cross-venue taxonomy. `/markets/search` takes a venue-specific `category`
 * instead and returns nothing for a meta value.
 *
 * WARNING: this endpoint answers an unrecognised query param with an empty
 * result set rather than an error — `sort_by`, `min_volume_24h` and
 * `close_before` all silently zero the results. Params are therefore filtered
 * to EVENT_SEARCH_KEYS here instead of being spread through. Rows come back
 * ordered by 24h volume descending already.
 */
export function searchOctagonEvents(
  params: SearchEventsParams,
  opts?: { timeoutMs?: number },
): Promise<PagedResult<OctagonEventSearchRow>> {
  const safe: Record<string, unknown> = { venues: OCTAGON_VENUE };
  for (const key of EVENT_SEARCH_KEYS) {
    const value = (params as Record<string, unknown>)[key];
    if (value !== undefined) safe[key] = value;
  }
  return venueApi<PagedResult<OctagonEventSearchRow>>('GET', '/markets/events/search', {
    params: safe,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/**
 * How long to wait on an event-level free-text query before giving up.
 *
 * Measured 2026-09-09: `meta_category` lookups return in well under a second,
 * but free text on this route is erratic — `q=bitcoin` and `q=election` both
 * exceeded 30s, while `/markets/search` answered the same queries in ~1-2s.
 * Free text is therefore a fallback with a short leash, not the primary path.
 */
export const EVENT_SEARCH_TEXT_TIMEOUT_MS = 8_000;

export interface SimilarParams {
  anchor_ticker?: string;
  q?: string;
  top_k?: number;
  category?: string;
  min_volume_24h?: number;
  close_before?: string;
}

/**
 * The venue-generic route returns a plain page; the Kalshi-era route echoed the
 * anchor back. Callers that displayed the anchor keep their own copy of it.
 */
export interface SimilarResponse extends PagedResult<SimilarMarketRow> {}

export function findSimilarMarkets(params: SimilarParams): Promise<SimilarResponse> {
  return venueApi<SimilarResponse>('GET', '/markets/similar', {
    params: {
      ...params,
      ...(params.anchor_ticker ? { anchor_ticker: addVenuePrefix(params.anchor_ticker) } : {}),
      venues: OCTAGON_VENUE,
    },
  });
}

// ─── Group B — Composites ───────────────────────────────────────────────────

export interface MarketsWithEdgeParams {
  run_id?: string;
  category?: string;
  edge_pp_min?: number;
  edge_pp_max?: number;
  expected_return_min?: number;
  total_volume_min?: number;
  model_probability_min?: number;
  sort_by?: 'edge_pp' | 'expected_return' | 'total_volume' | 'model_probability';
  limit?: number;
  cursor?: string;
}

/**
 * Polymarket edge scan, assembled from the venue-generic events feed.
 *
 * Octagon's server-side ranker (`/kalshi/markets-with-edge`) has no venue-generic
 * twin, so the filtering and sorting `markets-with-edge` would do server-side
 * happens here instead. That is affordable because the scored Polymarket
 * universe is small — a couple of hundred events, one page — and it keeps the
 * response shape identical so the existing formatter is unchanged.
 *
 * Probabilities on event rows are percentages (0-100) and `edge_pp` is already
 * in percentage points, matching what MarketsWithEdgeRow documents.
 */
export async function getEventsWithEdge(params: MarketsWithEdgeParams = {}): Promise<MarketsWithEdgeResponse> {
  const events = await fetchAllOctagonEvents();

  const category = params.category?.toLowerCase();
  const sortBy = params.sort_by ?? 'edge_pp';

  const rows: MarketsWithEdgeRow[] = events
    .filter((e) => e.model_probability !== null && e.model_probability !== undefined)
    .filter((e) => (category ? (e.series_category ?? e.meta_category ?? '').toLowerCase().includes(category) : true))
    .filter((e) => (params.edge_pp_min === undefined ? true : Math.abs(e.edge_pp ?? 0) >= params.edge_pp_min))
    .filter((e) => (params.edge_pp_max === undefined ? true : Math.abs(e.edge_pp ?? 0) <= params.edge_pp_max))
    .filter((e) => (params.expected_return_min === undefined ? true : (e.expected_return ?? 0) >= params.expected_return_min))
    .filter((e) => (params.total_volume_min === undefined ? true : (e.total_volume ?? 0) >= params.total_volume_min))
    .filter((e) => (params.model_probability_min === undefined ? true : (e.model_probability ?? 0) >= params.model_probability_min))
    .map((e) => ({
      event_ticker: e.event_ticker,
      market_ticker: null,
      title: e.name,
      series_category: e.series_category ?? e.meta_category ?? null,
      model_probability: e.model_probability,
      market_probability: e.market_probability,
      edge_pp: e.edge_pp,
      expected_return: e.expected_return,
      confidence_score: e.confidence_score,
      total_volume: e.total_volume,
      total_open_interest: e.total_open_interest,
      captured_at: e.captured_at,
    }));

  // edge_pp sorts by magnitude — an overpriced market is as tradeable as an
  // underpriced one, just on the other side.
  rows.sort((a, b) => {
    if (sortBy === 'edge_pp') return Math.abs(b.edge_pp) - Math.abs(a.edge_pp);
    if (sortBy === 'expected_return') return b.expected_return - a.expected_return;
    if (sortBy === 'total_volume') return b.total_volume - a.total_volume;
    return b.model_probability - a.model_probability;
  });

  const limit = params.limit ?? 20;
  // Each event carries its own run_id, so there is no single run to name — the
  // formatter omits the run when it is blank. Report the newest snapshot time.
  const captured = events.map((e) => e.captured_at).filter(Boolean).sort().pop() ?? null;
  return {
    run_id: '',
    captured_at: captured,
    sort_by: sortBy,
    data: rows.slice(0, limit),
    next_cursor: null,
    has_more: rows.length > limit,
  };
}

// ─── Endpoints added in subsequent sessions ─────────────────────────────────

