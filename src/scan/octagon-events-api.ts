/**
 * Octagon Prediction Markets Events API, scoped to Polymarket.
 *
 * Endpoints live under https://api.octagonai.co/v1/predictions/*. The older
 * /v1/prediction-markets/* namespace still responds but is deprecated and
 * Kalshi-shaped — it returns Kalshi rows regardless of any venue filter, which
 * is why this client must never fall back to it.
 *
 * Two identifier quirks this module absorbs so callers never see them:
 *
 *  - `event_ticker` is NOT the Polymarket URL slug. Octagon derives the ticker
 *    from the event when it is first ingested, so a renamed event keeps its old
 *    ticker (`will-the-us-invade-venezuela-in-2025` has slug
 *    `will-the-u-s-invade-venezuela-by`). Build polymarket.com links from
 *    `slug`; use `event_ticker` only as an Octagon key.
 *  - The /predictions/events routes take the BARE ticker. The `polymarket__`
 *    prefix appears only on /predictions/markets/* rows — see stripVenuePrefix
 *    in octagon-api.ts. Passing a prefixed ticker here 404s.
 */

/** The only venue this CLI reads. Octagon's `venue` filter is an enum: kalshi | polymarket. */
export const OCTAGON_VENUE = 'polymarket';

/**
 * A single event entry from the Octagon Prediction Markets Events API.
 *
 * Probability fields are PERCENTAGES (0-100) — unlike the market rows in
 * octagon-api.ts, whose prices are decimals (0-1). `edge_pp` is percentage
 * points; `expected_return` is a fraction.
 *
 * Almost everything is nullable: the list endpoint returns only the summary
 * columns, leaving key_takeaway/richtext/trader_trust_json null. Fetch the
 * detail endpoint (fetchOctagonEventDirect / fetchOctagonEventBySlug) when you
 * need the report body.
 */
export interface OctagonEventEntry {
  history_id: number;
  run_id: string;
  captured_at: string;
  event_ticker: string;
  /** 'polymarket' for every row this client fetches. */
  venue?: string | null;
  name: string;
  /** The polymarket.com/event/<slug> path segment. Differs from event_ticker. */
  slug: string;
  image_url?: string;
  series_category: string | null;
  /** Octagon's normalized cross-venue category; replaces Kalshi series categories. */
  meta_category?: string | null;
  /** Relative path fragment (e.g. 'politics/geopolitics'), not a full URL. */
  canonical_market_page?: string | null;
  resolution_cadence?: string | null;
  available_on_brokers: boolean;
  /** Polymarket's negRisk flag arrives here. */
  mutually_exclusive: boolean;
  analysis_last_updated: string;
  confidence_score: number;
  model_probability: number;
  market_probability: number;
  edge_pp: number;
  expected_return: number;
  r_score: number;
  total_volume: number;
  /** Always 0 for Polymarket — the venue has no open-interest concept. */
  total_open_interest: number;
  close_time: string;
  key_takeaway: string | null;
  has_history?: boolean;
  outcome_probabilities?: Array<{
    market_ticker: string;
    outcome_name?: string;
    model_probability: number;
    market_probability: number;
    volume?: number | null;
    volume_24h?: number | null;
  }> | null;
  current_state_summary_richtext?: string | null;
  short_answer_richtext?: string | null;
  executive_summary_richtext?: string | null;
  /** Set only when ?include=eligibility is requested. */
  eligible?: boolean | null;
  eligibility_status?: string | null;
  eligibility_reason?: string | null;
  /**
   * Trader Trust scorecard fields (added in calculation_version v1.0+).
   * Null on reports generated before this shipped — callers must guard.
   */
  trader_trust_subtitle?: string | null;
  /** Pre-rendered HTML; the CLI ignores this and reads trader_trust_json. */
  trader_trust_richtext?: string | null;
  /** JSON-encoded string. See TraderTrustCard in src/commands/trust.ts. */
  trader_trust_json?: string | null;
}

const EVENTS_API_BASE = 'https://api.octagonai.co/v1/predictions';
const PAGE_LIMIT = 200;
const TIMEOUT_MS = 60_000;

function requireKey(): string {
  const apiKey = process.env.OCTAGON_API_KEY;
  if (!apiKey) throw new Error('OCTAGON_API_KEY not set. Get one at https://app.octagonai.co');
  return apiKey;
}

/** Single fetch chokepoint: auth header, 60s abort, and a readable non-2xx error. */
async function eventsApi<T>(path: string, params?: URLSearchParams): Promise<T | null> {
  const apiKey = requireKey();
  const qs = params && [...params].length ? `?${params}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${EVENTS_API_BASE}${path}${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Octagon events API ${resp.status} (${path}): ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

interface EventsPage {
  data?: OctagonEventEntry[];
  next_cursor?: string | null;
  has_more?: boolean;
}

/**
 * Fetch a single page of Polymarket events with optional filters. Useful for CLI
 * commands that don't need the full universe — e.g. `events list --limit 50`.
 */
export async function fetchOctagonEventsPage(opts?: {
  limit?: number;
  cursor?: string | null;
  hasHistory?: boolean;
  metaCategory?: string;
}): Promise<{ data: OctagonEventEntry[]; next_cursor: string | null; has_more: boolean }> {
  const params = new URLSearchParams({
    limit: String(opts?.limit ?? PAGE_LIMIT),
    venue: OCTAGON_VENUE,
  });
  if (opts?.hasHistory) params.set('has_history', 'true');
  if (opts?.metaCategory) params.set('meta_category', opts.metaCategory);
  if (opts?.cursor) params.set('cursor', opts.cursor);

  const page = await eventsApi<EventsPage>('/events', params);
  return {
    data: Array.isArray(page?.data) ? page.data : [],
    next_cursor: page?.next_cursor ?? null,
    has_more: !!page?.has_more,
  };
}

/**
 * Look up a single event by its Octagon ticker. Returns null on 404.
 * Cheaper than `fetchOctagonEventByTicker`, which scans paginated pages.
 */
export function fetchOctagonEventDirect(eventTicker: string): Promise<OctagonEventEntry | null> {
  return eventsApi<OctagonEventEntry>(`/events/${encodeURIComponent(eventTicker)}`);
}

/**
 * Look up a single event by its Polymarket URL slug. Returns null on 404.
 *
 * This is the lookup most CLI input hits: users paste polymarket.com URLs or
 * slugs, which are frequently not the event_ticker.
 */
export function fetchOctagonEventBySlug(slug: string): Promise<OctagonEventEntry | null> {
  return eventsApi<OctagonEventEntry>(`/events/slug/${encodeURIComponent(slug)}`);
}

/**
 * Reduce user input to an Octagon event key.
 *
 * Accepts a polymarket.com URL, a `polymarket__`-namespaced ticker from the
 * /markets routes, or a bare slug. Lowercases, because Polymarket keys are
 * lowercase — the Kalshi-era code uppercased input, which 404s here.
 */
export function normalizeEventKey(input: string): string {
  const url = input.match(/^https?:\/\/(?:www\.)?polymarket\.com\/(?:event|market)\/([^/?#]+)/i);
  const raw = url ? url[1] : input;
  const i = raw.indexOf('__');
  return (i === -1 ? raw : raw.slice(i + 2)).trim().toLowerCase();
}

/**
 * Resolve user input that may be either an Octagon event ticker or a Polymarket
 * slug. Tries the slug route first — it is the form users actually have — then
 * falls back to the ticker route.
 */
export async function resolveOctagonEvent(input: string): Promise<OctagonEventEntry | null> {
  const key = normalizeEventKey(input);
  return (await fetchOctagonEventBySlug(key)) ?? (await fetchOctagonEventDirect(key));
}

/**
 * Look up a single event by ticker. Scans pages until found (universe is small).
 * Returns null if not found.
 */
export async function fetchOctagonEventByTicker(eventTicker: string): Promise<OctagonEventEntry | null> {
  const direct = await fetchOctagonEventDirect(eventTicker);
  if (direct) return direct;

  let cursor: string | null = null;
  do {
    const page: { data: OctagonEventEntry[]; next_cursor: string | null; has_more: boolean } =
      await fetchOctagonEventsPage({ cursor });
    const hit = page.data.find((e) => e.event_ticker === eventTicker);
    if (hit) return hit;
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return null;
}

/**
 * Fetch all Polymarket events, paginating through every page.
 * @param opts.hasHistory - When true, only return events with multiple historical snapshots.
 *   Note: The events list endpoint now returns `has_history` per event, so this filter
 *   is only needed if you want to reduce response size.
 */
export async function fetchAllOctagonEvents(opts?: { hasHistory?: boolean }): Promise<OctagonEventEntry[]> {
  requireKey();

  const all: OctagonEventEntry[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), venue: OCTAGON_VENUE });
    if (opts?.hasHistory) params.set('has_history', 'true');
    if (cursor) params.set('cursor', cursor);

    const page = await eventsApi<EventsPage>('/events', params);
    if (!page || typeof page !== 'object') {
      throw new Error('Octagon events API returned invalid response shape');
    }
    if (!Array.isArray(page.data)) {
      throw new Error('Octagon events API response missing data array');
    }
    const hasMore = typeof page.has_more === 'boolean' ? page.has_more : false;
    if (hasMore && !page.next_cursor) {
      throw new Error('Octagon events API has_more=true but next_cursor is missing');
    }
    all.push(...page.data);
    cursor = hasMore ? page.next_cursor! : null;
  } while (cursor);

  return all;
}
