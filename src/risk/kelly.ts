import { fetchPortfolioValue, fetchPositions, getWalletAddress } from "../tools/polymarket/portfolio.js";
import type { PolymarketMarket } from "../tools/polymarket/types.js";
import { getBotSetting } from "../utils/bot-config.js";

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
  availableBankroll: number; // cash - open exposure (USDC)
  openExposure: number; // sum of position current_value (USDC)
  cashBalance: number; // configured bankroll (USDC)
  portfolioValue: number; // mark-to-market position value (USDC)
  liquidityAdjusted: boolean;
  skippedReason?: string; // if shares=0, explains why
}

export interface LiveBankroll {
  cashBalance: number; // USDC
  portfolioValue: number; // USDC
  openExposure: number; // USDC
  availableBankroll: number; // USDC
  /** True when no bankroll is configured, so sizing cannot be computed. */
  bankrollUnset: boolean;
  /**
   * Free collateral read from the chain, or null when it is not readable.
   *
   * Always null until wallet support lands — there is no chain read yet. It is
   * deliberately NOT the configured `risk.bankroll_usdc`: that number is static,
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
 * Fetch live bankroll, in USDC.
 *
 * Polymarket has no equivalent of Kalshi's /portfolio/balance: free collateral
 * is pUSD held on-chain, and the Data API reports only position value. Cash must therefore be
 * configured via `risk.bankroll_usdc`; when it is not, `bankrollUnset` is true and
 * callers should say so rather than size against a number we do not have.
 */
export async function fetchLiveBankroll(): Promise<LiveBankroll> {
  // Research and scanning must work without a wallet, so a missing or
  // unreachable wallet degrades to zeros instead of throwing.
  let value = { portfolio_value: 0, address: '' };
  let positions: Awaited<ReturnType<typeof fetchPositions>> = [];
  if (getWalletAddress()) {
    try {
      [value, positions] = await Promise.all([fetchPortfolioValue(), fetchPositions()]);
    } catch {
      // Data API unreachable — fall through with zeros
    }
  }

  const configured = Number(getBotSetting('risk.bankroll_usdc') ?? 0);
  const cashBalance = Number.isFinite(configured) && configured > 0 ? configured : 0;
  const portfolioValue = value.portfolio_value;
  const openExposure = positions.reduce((sum, p) => sum + (p.current_value || 0), 0);
  const availableBankroll = Math.max(0, cashBalance - openExposure);

  // No chain read exists yet, so cash is unknown rather than zero and equity is
  // therefore unknown too. Snapshots taken now record NULL and are skipped by
  // every high-water-mark walk, which is what stops them from being read later
  // as an account that fell to nothing.
  const walletCash: number | null = null;

  return {
    cashBalance,
    portfolioValue,
    openExposure,
    availableBankroll,
    bankrollUnset: cashBalance === 0,
    walletCash,
    equity: walletCash === null ? null : walletCash + portfolioValue,
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
      skippedReason: 'No bankroll configured — set risk.bankroll_usdc (Polymarket does not expose a cash balance)',
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
      ? 'No available bankroll'
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
