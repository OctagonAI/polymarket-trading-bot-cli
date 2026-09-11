import { fetchPortfolioValue, fetchPositions, getWalletAddress } from "../tools/polymarket/portfolio.js";
import type { PolymarketMarket } from "../tools/polymarket/types.js";
import { getBotSetting } from "../utils/bot-config.js";
import { readPusdBalance } from "../chain/erc20.js";

export interface KellySizeParams {
  edge: number; // model_prob - market_prob (signed)
  marketProb: number; // current market-implied probability (0-1)
  multiplier?: number; // Kelly fraction, default 0.5 (half-Kelly)
  maxPositionPct?: number; // max % of bankroll per position, default 0.10
  minEdgeThreshold?: number; // min absolute edge to size, default 0.05 (5%)
  market?: PolymarketMarket; // for liquidity adjustment (spread, volume)
}

/**
 * All monetary fields are USDC; all price fields are decimal probabilities in
 * [0,1]. (The Kalshi version of this module worked in integer cents.)
 */
export interface KellyResult {
  side: 'yes' | 'no'; // which outcome to buy
  fraction: number; // raw Kelly fraction (before multiplier)
  adjustedFraction: number; // after multiplier + liquidity adj
  shares: number; // outcome shares to buy
  notionalUsdc: number; // shares * entryPrice
  entryPrice: number; // actual entry price used (ask, not midpoint), 0-1
  availableBankroll: number; // min(wallet cash, cap - open exposure), in USD
  openExposure: number | null; // sum of position current_value; null if unreadable
  cashBalance: number; // wallet balance, or the configured cap standing in for it
  portfolioValue: number | null; // mark-to-market position value; null if unreadable
  liquidityAdjusted: boolean;
  skippedReason?: string; // if shares=0, explains why
}

/** Where `availableBankroll` came from — surfaced so output can explain itself. */
export type BankrollSource = 'none' | 'wallet' | 'config' | 'capped';

export interface LiveBankroll {
  cashBalance: number; // USDC
  /**
   * Mark-to-market position value, or null when the Data API could not be read.
   *
   * Null rather than 0 for the same reason as `walletCash`: a failed read is
   * not an empty book, and treating it as one understates equity, which shows
   * up as a phantom drawdown.
   */
  portfolioValue: number | null;
  /** Sum of position values, or null when positions could not be read. */
  openExposure: number | null;
  availableBankroll: number; // USDC
  /** True when neither a wallet balance nor a configured cap is available. */
  bankrollUnset: boolean;
  bankrollSource: BankrollSource;
  /** The configured `risk.bankroll_usdc` ceiling, or null when unset. */
  cap: number | null;
  /** The Data API position list could not be read; exposure is unknown. */
  positionsUnavailable: boolean;
  /** The Data API value endpoint could not be read. */
  portfolioValueUnavailable: boolean;
  /**
   * Free pUSD read from the chain, or null when it is not readable.
   *
   * Deliberately NOT the configured `risk.bankroll_usdc`: that number is static,
   * so it would not fall as cash is spent, and equity would then appear to grow
   * every time a position is opened.
   */
  walletCash: number | null;
  /**
   * `walletCash + portfolioValue`, or null when `walletCash` is null.
   *
   * The value drawdown is measured against. Unlike `portfolioValue` it does not
   * move when a position is closed, because the value simply shifts between the
   * two terms.
   */
  equity: number | null;
}

/**
 * Fetch live bankroll, in USD.
 *
 * Two independent sources, and they mean different things:
 *
 *  - **`walletCash`** — free pUSD read from the chain. Polymarket has no
 *    equivalent of Kalshi's /portfolio/balance, so this is an ERC-20 read
 *    against the funding wallet. It is ALREADY net of open positions, because
 *    positions are held as outcome tokens rather than as encumbered cash.
 *  - **`risk.bankroll_usdc`** — a ceiling the user sets on what sizing may
 *    risk in total. Static, so it does not fall as cash is spent.
 *
 * Because they mean different things they combine rather than override:
 *
 *     available = min( walletCash , cap - openExposure )
 *
 * with a missing term dropping out. Subtracting `openExposure` from the wallet
 * balance would double-count — the classic error here — while not subtracting
 * it from the cap would let a ceiling of 1,000 deploy 1,000 twice.
 */
export async function fetchLiveBankroll(): Promise<LiveBankroll> {
  // Research and scanning must work without a wallet, so a missing or
  // unreachable wallet degrades to zeros instead of throwing.
  let portfolioValue: number | null = null;
  let positions: Awaited<ReturnType<typeof fetchPositions>> | null = null;
  let walletCash: number | null = null;

  const address = getWalletAddress();
  if (address) {
    // allSettled, not all: the Data API and the Polygon RPC fail independently,
    // and one being down must not blank the other. Issued together so the cash
    // and position legs of equity are read at close to the same instant — they
    // are still not atomic, so a snapshot taken across a fill can show a
    // transient blip.
    const [valueRes, positionsRes, cashRes] = await Promise.allSettled([
      fetchPortfolioValue(),
      fetchPositions(),
      readPusdBalance(address),
    ]);
    if (valueRes.status === 'fulfilled') portfolioValue = valueRes.value.portfolio_value;
    if (positionsRes.status === 'fulfilled') positions = positionsRes.value;
    if (cashRes.status === 'fulfilled') walletCash = cashRes.value;
  }

  const rawCap = Number(getBotSetting('risk.bankroll_usdc') ?? 0);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null;

  const openExposure =
    positions === null ? null : positions.reduce((sum, p) => sum + (p.current_value || 0), 0);

  // Each term is dropped when unknown rather than defaulted to zero: a failed
  // balance read must not read as "no money", and an unset cap must not read as
  // "cap of nothing".
  const limits: number[] = [];
  if (walletCash !== null) limits.push(walletCash);
  // Unknown exposure is netted as 0 rather than refusing to size: the wallet
  // term usually binds anyway, and `positionsUnavailable` tells the caller the
  // cap arm is provisional.
  if (cap !== null) limits.push(cap - (openExposure ?? 0));
  const availableBankroll = limits.length > 0 ? Math.max(0, Math.min(...limits)) : 0;

  const bankrollSource: BankrollSource =
    walletCash !== null && cap !== null ? 'capped'
    : walletCash !== null ? 'wallet'
    : cap !== null ? 'config'
    : 'none';

  return {
    // The real balance when we have one, else the configured figure standing in
    // for it. `walletCash` stays separately available for anything that must
    // not accept a stand-in — the equity maths, above all.
    cashBalance: walletCash ?? cap ?? 0,
    portfolioValue,
    openExposure,
    availableBankroll,
    bankrollUnset: bankrollSource === 'none',
    bankrollSource,
    cap,
    walletCash,
    // Equity needs BOTH terms. With either missing it is unknown, not partial —
    // a half-computed equity is what produces a phantom drawdown.
    equity: walletCash === null || portfolioValue === null ? null : walletCash + portfolioValue,
    positionsUnavailable: positions === null,
    portfolioValueUnavailable: portfolioValue === null,
  };
}

/** 24h volume in USDC. */
export function getVolume24h(market: PolymarketMarket): number {
  return Number.isFinite(market.volume_24h) ? market.volume_24h : 0;
}

/**
 * Bid/ask spread in cents. Kept in cents because the risk thresholds
 * (`risk.max_spread_cents`, `risk.liquidity_spread_threshold`) are expressed
 * that way and it reads better than "0.03 spread".
 */
export function getSpreadCents(market: PolymarketMarket): number {
  const { yes_bid: bid, yes_ask: ask } = market;
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) {
    return Math.round((ask - bid) * 100);
  }
  return 99; // unknown spread → treat as very wide
}

/**
 * Compute Kelly-optimal position size using live portfolio data.
 *
 * For YES bets (edge > 0): f* = edge / (1 - marketProb)
 * For NO bets  (edge < 0): f* = |edge| / marketProb
 */
export async function kellySize(params: KellySizeParams): Promise<KellyResult> {
  const { edge, marketProb, market } = params;
  const multiplier = params.multiplier ?? (getBotSetting('risk.kelly_multiplier') as number);
  const maxPositionPct = params.maxPositionPct ?? (getBotSetting('risk.max_position_pct') as number);
  const minEdgeThreshold = params.minEdgeThreshold ?? (getBotSetting('risk.min_edge_threshold') as number);

  const bankroll = await fetchLiveBankroll();
  const { cashBalance, portfolioValue, openExposure, availableBankroll } = bankroll;

  const side: 'yes' | 'no' = edge >= 0 ? 'yes' : 'no';

  // Compute executable probability from the ask price we'd actually trade at.
  // YES buy → yes_ask; NO buy → no_ask expressed as YES-equivalent (1 - no_ask)
  let executableProb: number | null = null;
  if (market) {
    if (side === 'yes') {
      if (Number.isFinite(market.yes_ask) && market.yes_ask > 0) executableProb = market.yes_ask;
    } else {
      if (Number.isFinite(market.no_ask) && market.no_ask > 0) executableProb = 1 - market.no_ask;
    }
  }
  // Fall back to midpoint if no executable quote is available
  const pricingProb = executableProb ?? marketProb;

  // Recompute edge relative to executable quote to avoid overstating edge;
  // when no executable quote is available, use the original edge directly
  // to avoid floating-point roundtrip error from (marketProb + edge) - marketProb.
  const executableEdge = executableProb != null
    ? (marketProb + edge) - executableProb
    : edge;
  const absEdge = Math.abs(executableEdge);

  // Entry price from executable quote — computed early so it's available even when sizing is skipped
  const yesEntry = executableProb ?? marketProb;
  const entryPrice = side === 'yes' ? yesEntry : 1 - yesEntry;

  const makeResult = (overrides: Partial<KellyResult> = {}): KellyResult => ({
    side,
    fraction: 0,
    adjustedFraction: 0,
    shares: 0,
    notionalUsdc: 0,
    entryPrice,
    availableBankroll,
    openExposure,
    cashBalance,
    portfolioValue,
    liquidityAdjusted: false,
    ...overrides,
  });

  if (bankroll.bankrollUnset) {
    return makeResult({
      skippedReason:
        'No bankroll available — configure a wallet (polymarket wallet create) so the ' +
        'pUSD balance can be read, or set a limit with: polymarket config risk.bankroll_usdc <amount>',
    });
  }

  // Minimum edge threshold — don't size if edge is within model error
  if (absEdge < minEdgeThreshold) {
    return makeResult({ skippedReason: `Edge ${(absEdge * 100).toFixed(1)}% below ${(minEdgeThreshold * 100).toFixed(0)}% threshold` });
  }

  // Guard against extreme probabilities that would cause division by zero
  if (pricingProb <= 0 || pricingProb >= 1) {
    return makeResult({ skippedReason: 'Extreme probability — cannot size' });
  }

  // Kelly formula for binary outcome using executable quote
  // YES: f* = executableEdge / (1 - pricingProb)  — cost is pricingProb, payoff is (1 - pricingProb)
  // NO:  f* = |executableEdge| / pricingProb       — cost is (1 - pricingProb), payoff is pricingProb
  const fraction = side === 'yes'
    ? executableEdge / (1 - pricingProb)
    : absEdge / pricingProb;

  let adjustedFraction = fraction * multiplier;
  let liquidityAdjusted = false;

  // Liquidity adjustment: wide spread or low volume → apply haircut
  if (market) {
    const spreadCents = getSpreadCents(market);
    const liqSpreadThreshold = getBotSetting('risk.liquidity_spread_threshold') as number;
    const liqVolumeThreshold = getBotSetting('risk.liquidity_volume_threshold') as number;
    const liqHaircut = getBotSetting('risk.liquidity_haircut') as number;
    if (spreadCents > liqSpreadThreshold || getVolume24h(market) < liqVolumeThreshold) {
      adjustedFraction *= liqHaircut;
      liquidityAdjusted = true;
    }
  }

  // Notional before position cap
  let notionalUsdc = adjustedFraction * availableBankroll;

  // Cap at maxPositionPct of available bankroll
  notionalUsdc = Math.min(notionalUsdc, maxPositionPct * availableBankroll);

  // Polymarket shares are fractional; round to 2dp and respect the venue minimum.
  let shares = 0;
  if (entryPrice > 0 && notionalUsdc > 0) {
    shares = Math.floor((notionalUsdc / entryPrice) * 100) / 100;
    const minSize = market?.min_order_size ?? 0;
    if (minSize > 0 && shares < minSize) shares = 0;
  }

  const skippedReason = shares === 0
    ? (availableBankroll === 0
      // Naming the binding constraint matters: a cap swallowed by existing
      // exposure looks identical to an empty wallet, and the fix is different.
      ? (bankroll.cap !== null
        ? `No available bankroll: the risk.bankroll_usdc limit of $${bankroll.cap.toFixed(2)} is fully `
          + `used by $${(openExposure ?? 0).toFixed(2)} of open positions. Raise the limit to size new trades.`
        : 'No available bankroll: the wallet has no free pUSD.')
      : entryPrice === 0
        ? 'Entry price rounds to zero'
        : `Position below the ${market?.min_order_size ?? 0}-share venue minimum`)
    : undefined;

  // Recalculate notional based on actual shares
  notionalUsdc = shares * entryPrice;

  return makeResult({
    fraction,
    adjustedFraction,
    shares,
    notionalUsdc,
    entryPrice,
    liquidityAdjusted,
    skippedReason,
  });
}
