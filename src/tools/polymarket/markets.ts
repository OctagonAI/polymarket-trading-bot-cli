import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi, fetchAllGammaPages, num, parseGammaJsonArray, type ApiParams } from './api.js';
import { formatToolResult } from '../types.js';
import type {
  PolymarketMarket,
  PolymarketOrderbook,
  PolymarketOrderbookLevel,
  PolymarketPricePoint,
} from './types.js';

/** Raw Gamma market row. Gamma mixes numbers and numeric strings, so read via num(). */
type GammaMarket = Record<string, unknown>;

function marketStatus(raw: GammaMarket): string {
  if (raw.archived === true) return 'archived';
  if (raw.closed === true) return 'closed';
  if (raw.active === true) return 'active';
  return 'inactive';
}

/**
 * Winning outcome once a market has closed. Polymarket settles through the UMA
 * oracle, which drives the winning outcome's price to 1.
 */
function marketResult(raw: GammaMarket, outcomes: string[], prices: number[]): string {
  if (raw.closed !== true) return '';
  const winner = prices.findIndex((p) => p >= 0.99);
  return winner >= 0 ? (outcomes[winner] ?? '').toLowerCase() : '';
}

/**
 * Normalize a Gamma market row into the CLI's domain type.
 *
 * Two things worth knowing:
 *  - Outcomes are NOT always ["Yes","No"] — a sports market is
 *    ["Frances Tiafoe","Alex Michelsen"]. Index 0 is treated as the YES side.
 *  - `bestBid`/`bestAsk` quote outcome 0 only; the complement side is derived,
 *    since a YES bid at 0.21 is a NO ask at 0.79.
 */
export function normalizeGammaMarket(raw: GammaMarket, fallbackCategory = ''): PolymarketMarket {
  const outcomes = parseGammaJsonArray(raw.outcomes);
  const prices = parseGammaJsonArray(raw.outcomePrices).map((p) => num(p));
  const tokenIds = parseGammaJsonArray(raw.clobTokenIds);
  const events = Array.isArray(raw.events) ? (raw.events as GammaMarket[]) : [];
  const event = events[0];

  const yesBid = num(raw.bestBid);
  const yesAsk = num(raw.bestAsk);

  return {
    ticker: String(raw.slug ?? ''),
    condition_id: String(raw.conditionId ?? ''),
    question_id: raw.questionID ? String(raw.questionID) : undefined,
    event_ticker: String(event?.slug ?? event?.ticker ?? ''),
    series_ticker: undefined,
    token_ids: tokenIds,
    outcomes,

    title: String(raw.question ?? ''),
    subtitle: String(raw.groupItemTitle ?? ''),
    yes_sub_title: outcomes[0] ?? 'Yes',
    no_sub_title: outcomes[1] ?? 'No',

    status: marketStatus(raw),
    open_time: String(raw.startDate ?? ''),
    close_time: String(raw.endDate ?? ''),
    expiration_time: String(raw.endDate ?? ''),

    yes_bid: yesBid,
    yes_ask: yesAsk,
    // Complement side: the book for outcome 1 mirrors outcome 0 around 1.0.
    no_bid: yesAsk > 0 ? 1 - yesAsk : 0,
    no_ask: yesBid > 0 ? 1 - yesBid : 0,
    last_price: num(raw.lastTradePrice, prices[0] ?? 0),
    previous_price: raw.oneDayPriceChange !== undefined
      ? num(raw.lastTradePrice, prices[0] ?? 0) - num(raw.oneDayPriceChange)
      : undefined,

    volume: num(raw.volumeNum ?? raw.volume),
    volume_24h: num(raw.volume24hr),
    liquidity: num(raw.liquidityNum ?? raw.liquidity),
    open_interest: num(raw.openInterest),

    tick_size: num(raw.orderPriceMinTickSize, 0.01),
    min_order_size: num(raw.orderMinSize, 5),
    neg_risk: raw.negRisk === true,
    accepting_orders: raw.acceptingOrders === true,

    category: String(raw.category ?? event?.category ?? fallbackCategory ?? ''),
    result: marketResult(raw, outcomes, prices),
  };
}

// --- Typed fetchers ---

export interface MarketQuery {
  event_ticker?: string;
  slugs?: string[];
  condition_ids?: string[];
  closed?: boolean;
  active?: boolean;
  limit?: number;
  order?: string;
  ascending?: boolean;
}

function toParams(q: MarketQuery): ApiParams {
  const params: ApiParams = {};
  if (q.slugs?.length) params.slug = q.slugs;
  if (q.condition_ids?.length) params.condition_ids = q.condition_ids;
  if (q.closed !== undefined) params.closed = q.closed;
  if (q.active !== undefined) params.active = q.active;
  if (q.limit) params.limit = q.limit;
  if (q.order) params.order = q.order;
  if (q.ascending !== undefined) params.ascending = q.ascending;
  return params;
}

export async function fetchMarkets(q: MarketQuery = {}): Promise<PolymarketMarket[]> {
  const raw = await callPolymarketApi<GammaMarket[]>('gamma', 'GET', '/markets', {
    params: { limit: 100, ...toParams(q) },
  });
  return (Array.isArray(raw) ? raw : []).map((m) => normalizeGammaMarket(m));
}

export async function fetchAllMarkets(
  q: MarketQuery = {},
  maxPages = 10,
  onProgress?: (info: { fetchedItems: number; page: number; maxPages: number }) => void
): Promise<PolymarketMarket[]> {
  const raw = await fetchAllGammaPages<GammaMarket>('/markets', toParams(q), 100, maxPages, onProgress);
  return raw.map((m) => normalizeGammaMarket(m));
}

export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | undefined> {
  const markets = await fetchMarkets({ slugs: [slug], limit: 1 });
  return markets[0];
}

export async function fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | undefined> {
  const markets = await fetchMarkets({ condition_ids: [conditionId], limit: 1 });
  return markets[0];
}

/**
 * Accept anything a user might paste and return the market slug:
 * a bare slug, a 0x condition id, or a polymarket.com URL.
 * Event URLs carry the event slug, which callers resolve separately.
 */
export function normalizePolymarketInput(input: string): string {
  let s = input.trim();
  if (!s) return s;

  const urlMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?polymarket\.com\/(?:event|market)\/([^/?#]+)(?:\/([^/?#]+))?/i);
  if (urlMatch) {
    // /event/<event-slug>/<market-slug> — the market slug wins when present.
    s = urlMatch[2] || urlMatch[1] || '';
  }

  return s.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Resolve a slug, condition id, or URL to a market. */
export async function lookupMarket(input: string): Promise<PolymarketMarket | undefined> {
  const key = normalizePolymarketInput(input);
  if (!key) return undefined;
  if (/^0x[0-9a-fA-F]{40,}$/.test(key)) return fetchMarketByConditionId(key);
  return fetchMarketBySlug(key);
}

// --- Order book (CLOB, per outcome token) ---

function toLevels(raw: unknown): PolymarketOrderbookLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({ price: num((l as Record<string, unknown>)?.price), size: num((l as Record<string, unknown>)?.size) }))
    .filter((l) => l.size > 0);
}

/**
 * Fetch one outcome token's book. CLOB returns bids ascending and asks
 * descending; both are re-sorted best-first so callers can read index 0.
 */
export async function fetchOrderbook(
  tokenId: string,
  ticker = '',
  outcome = ''
): Promise<PolymarketOrderbook> {
  const raw = await callPolymarketApi<Record<string, unknown>>('clob', 'GET', '/book', {
    params: { token_id: tokenId },
  });
  return {
    ticker,
    token_id: tokenId,
    outcome,
    bids: toLevels(raw?.bids).sort((a, b) => b.price - a.price),
    asks: toLevels(raw?.asks).sort((a, b) => a.price - b.price),
  };
}

/** Book for a market's primary (index 0) outcome. */
export async function fetchMarketOrderbook(market: PolymarketMarket): Promise<PolymarketOrderbook | undefined> {
  const tokenId = market.token_ids[0];
  if (!tokenId) return undefined;
  return fetchOrderbook(tokenId, market.ticker, market.outcomes[0] ?? '');
}

// --- Price history (CLOB, replaces Kalshi candlesticks) ---

export type PriceHistoryInterval = '1m' | '1h' | '6h' | '1d' | '1w' | 'max';

export async function fetchPricesHistory(
  tokenId: string,
  opts: { interval?: PriceHistoryInterval; startTs?: number; endTs?: number; fidelity?: number } = {}
): Promise<PolymarketPricePoint[]> {
  const params: ApiParams = { market: tokenId };
  if (opts.startTs && opts.endTs) {
    params.startTs = opts.startTs;
    params.endTs = opts.endTs;
  } else {
    params.interval = opts.interval ?? '1d';
  }
  if (opts.fidelity) params.fidelity = opts.fidelity;

  const raw = await callPolymarketApi<{ history?: Array<Record<string, unknown>> }>(
    'clob',
    'GET',
    '/prices-history',
    { params }
  );
  return (raw?.history ?? []).map((p) => ({ ts: num(p.t), price: num(p.p) }));
}

// --- Agent tools ---

export const getMarkets = new DynamicStructuredTool({
  name: 'get_markets',
  description:
    'List Polymarket markets, optionally filtered by event slug or status. Prices are decimal probabilities in [0,1].',
  schema: z.object({
    event_ticker: z.string().optional().describe('Filter by event slug'),
    status: z.enum(['open', 'closed']).optional().describe('Market status filter'),
    tickers: z.array(z.string()).optional().describe('Specific market slugs to fetch'),
    limit: z.number().optional().describe('Max markets to return (default 100)'),
  }),
  func: async (input) => {
    if (input.event_ticker) {
      const raw = await callPolymarketApi<Record<string, unknown>[]>('gamma', 'GET', '/events', {
        params: { slug: input.event_ticker, limit: 1 },
      });
      const nested = Array.isArray(raw?.[0]?.markets) ? (raw[0].markets as GammaMarket[]) : [];
      return formatToolResult({ markets: nested.map((m) => normalizeGammaMarket(m)) });
    }
    const markets = await fetchMarkets({
      slugs: input.tickers,
      closed: input.status ? input.status === 'closed' : undefined,
      limit: input.limit ?? 100,
    });
    return formatToolResult({ markets });
  },
});

export const getMarket = new DynamicStructuredTool({
  name: 'get_market',
  description: 'Get one Polymarket market by slug, condition id, or polymarket.com URL.',
  schema: z.object({
    ticker: z.string().describe('Market slug (e.g. xi-jinping-out-before-2027), condition id, or URL'),
  }),
  func: async (input) => {
    const market = await lookupMarket(input.ticker);
    return formatToolResult(market ? { market } : { error: `No market found for "${input.ticker}"` });
  },
});

export const getMarketOrderbook = new DynamicStructuredTool({
  name: 'get_market_orderbook',
  description: 'Get the live CLOB order book for a Polymarket market (primary outcome token).',
  schema: z.object({
    ticker: z.string().describe('Market slug, condition id, or URL'),
  }),
  func: async (input) => {
    const market = await lookupMarket(input.ticker);
    if (!market) return formatToolResult({ error: `No market found for "${input.ticker}"` });
    const book = await fetchMarketOrderbook(market);
    return formatToolResult(book ? { orderbook: book } : { error: 'Market has no tradeable outcome token' });
  },
});

export const getMarketPriceHistory = new DynamicStructuredTool({
  name: 'get_market_price_history',
  description: 'Get historical prices for a Polymarket market (replaces Kalshi candlesticks).',
  schema: z.object({
    ticker: z.string().describe('Market slug, condition id, or URL'),
    interval: z.enum(['1m', '1h', '6h', '1d', '1w', 'max']).optional().describe('Lookback window (default 1d)'),
  }),
  func: async (input) => {
    const market = await lookupMarket(input.ticker);
    if (!market) return formatToolResult({ error: `No market found for "${input.ticker}"` });
    const tokenId = market.token_ids[0];
    if (!tokenId) return formatToolResult({ error: 'Market has no tradeable outcome token' });
    const history = await fetchPricesHistory(tokenId, { interval: input.interval ?? '1d' });
    return formatToolResult({ ticker: market.ticker, outcome: market.outcomes[0], history });
  },
});
