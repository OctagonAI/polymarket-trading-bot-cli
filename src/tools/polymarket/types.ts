/**
 * Polymarket domain types.
 *
 * UNITS: every price in this file is a decimal probability in [0, 1] — USDC per
 * share — NOT Kalshi-style integer cents. A YES ask of 0.42 means $0.42 per
 * share. YES + NO ≈ 1.
 *
 * IDENTIFIERS: Polymarket has four levels where Kalshi had three.
 *   series (slug) → event (slug) → market (slug + condition_id) → outcome token_id
 * `token_id` values are uint256 **decimal strings** (~78 digits). Never pass one
 * through Number() — precision is lost silently.
 */

/** Human-readable market identifier. Slugs are stable and URL-safe. */
export type MarketSlug = string;

export interface PolymarketMarket {
  /** Market slug — the human-facing identifier used everywhere in the CLI. */
  ticker: MarketSlug;
  /** Canonical on-chain identifier (0x…). Required for CLOB order placement. */
  condition_id: string;
  question_id?: string;
  /** Parent event slug. */
  event_ticker: string;
  /** Parent series slug, when the event belongs to one. */
  series_ticker?: string;
  /** Outcome token ids, parallel to `outcomes`. Decimal strings — keep as strings. */
  token_ids: string[];
  /** Outcome labels, e.g. ["Yes", "No"]. */
  outcomes: string[];

  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;

  /** 'active' | 'closed' | 'resolved' */
  status: string;
  open_time: string;
  close_time: string;
  expiration_time: string;

  // --- Prices: decimal 0-1 ---
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  previous_price?: number;

  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;

  /** Minimum price increment: 0.01 or 0.001. */
  tick_size: number;
  /** Minimum order size in shares. */
  min_order_size: number;
  /** Multi-outcome event where outcome prices sum to 1 (Kalshi's mutually_exclusive). */
  neg_risk: boolean;
  accepting_orders: boolean;

  category: string;
  /** '' while open; 'yes' | 'no' once the UMA oracle resolves it. */
  result: string;
}

export interface PolymarketEvent {
  event_ticker: string;
  series_ticker?: string;
  title: string;
  sub_title: string;
  /** Outcomes are mutually exclusive (neg-risk event). */
  mutually_exclusive: boolean;
  category: string;
  tags: string[];
  close_time: string;
  strike_date: string;
  volume: number;
  volume_24h: number;
  liquidity: number;
  markets?: PolymarketMarket[];
}

export interface PolymarketSeries {
  ticker: string;
  title: string;
  category: string;
  /** 'daily' | 'weekly' | 'monthly' | … */
  frequency: string;
  tags: string[];
  volume_24h: number;
}

export interface PolymarketOrderbookLevel {
  /** Decimal 0-1. */
  price: number;
  /** Size in shares. */
  size: number;
}

/**
 * A CLOB book is per outcome token, not per market. Kalshi returned one book
 * with `yes`/`no` arrays; here `bids`/`asks` are the two sides of ONE token's
 * book, and `token_id` says which outcome it belongs to.
 */
export interface PolymarketOrderbook {
  ticker: MarketSlug;
  token_id: string;
  outcome: string;
  bids: PolymarketOrderbookLevel[];
  asks: PolymarketOrderbookLevel[];
}

/** One point from CLOB /prices-history. */
export interface PolymarketPricePoint {
  /** Unix seconds. */
  ts: number;
  /** Decimal 0-1. */
  price: number;
}

/** A position from the Data API. Amounts are USDC. */
export interface PolymarketPosition {
  ticker: MarketSlug;
  condition_id: string;
  event_ticker: string;
  token_id: string;
  outcome: string;
  title: string;
  /** Shares held. */
  size: number;
  /** Average entry price, decimal 0-1. */
  avg_price: number;
  /** Current mark price, decimal 0-1. */
  cur_price: number;
  /** size * cur_price, in USDC. */
  current_value: number;
  initial_value: number;
  cash_pnl: number;
  percent_pnl: number;
  realized_pnl: number;
  redeemable: boolean;
}

/** Aggregate account value from the Data API. USDC. */
export interface PolymarketBalance {
  /** Total mark-to-market value of open positions. */
  portfolio_value: number;
  /** Wallet address the values belong to. */
  address: string;
}

export interface PolymarketExchangeStatus {
  exchange_active: boolean;
  trading_active: boolean;
}
