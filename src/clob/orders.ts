/**
 * Turning "buy 50 shares of this market's Yes at 0.42" into a signed CLOB order.
 *
 * Four things here are easy to get wrong and expensive when you do:
 *
 *  1. **Which token.** `token_ids` is parallel to `outcomes`, so the side is
 *     resolved by matching the outcome LABEL. Indexing positionally — assuming
 *     0 is Yes — silently buys the opposite side of the trade, and the order
 *     succeeds, so nothing surfaces the mistake until the market resolves.
 *  2. **What the size means.** A market BUY is denominated in dollars
 *     (`amount`), a market SELL in shares (`shares`). This CLI takes shares in
 *     both cases, so a market buy converts shares → dollars at the executable
 *     price. Passing shares straight through would spend $50 where the user
 *     asked for 50 shares.
 *  3. **Tick size.** A price off-tick is rejected by the venue, so limit prices
 *     are rounded to the market's tick before signing.
 *  4. **Which half of the fill is shares.** The response reports the maker and
 *     taker legs, and which one is shares flips with the side — see `postOrder`.
 */
import { OrderSide, OrderType, type SignedOrder, type OrderResponse } from '@polymarket/client';
import { getClobClient } from './client.js';
import { roundToTick } from '../tools/polymarket/api.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';

export type TradeAction = 'buy' | 'sell';

/**
 * Smallest notional the venue accepts on a marketable buy, in dollars.
 *
 * A market buy is denominated in dollars, so this binds on the *value* of the
 * order, not the share count — and a market's own share minimum is no guarantee
 * of clearing it. On a cheap outcome the two disagree badly: five shares at
 * $0.047 satisfies a five-share minimum and is still only $0.23.
 *
 * The venue remains the authority. This exists so the refusal arrives before
 * signing, naming the size that would work, rather than as "min size: 1" —
 * which reads like one share when it means one dollar.
 */
export const MIN_MARKET_BUY_USD = 1;

/** Base units per dollar / per share in a signed order. */
const UNITS = 1_000_000;

/**
 * What a signed order actually gives up and receives.
 *
 * Which leg is shares flips with the side: a buy offers dollars and receives
 * shares, a sell the reverse. Reading the same leg for both reports a dollar
 * amount as a share count.
 */
function legs(signed: SignedOrder, side: OrderSide): { shares: number; usd: number } {
  const maker = Number(signed.makerAmount) / UNITS;
  const taker = Number(signed.takerAmount) / UNITS;
  return side === OrderSide.BUY ? { shares: taker, usd: maker } : { shares: maker, usd: taker };
}

export interface OrderRequest {
  market: PolymarketMarket;
  action: TradeAction;
  /** Outcome label, or `yes`/`no` for a binary market. */
  outcome: string;
  /** Always shares, for both buys and sells. */
  shares: number;
  /** Decimal USD. Omitted means a market order. */
  limitPrice?: number;
}

export interface ResolvedOutcome {
  label: string;
  tokenId: string;
  index: number;
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

/**
 * Match a user's outcome word to one of the market's outcomes.
 *
 * `yes`/`no` are accepted as aliases only when the market actually has outcomes
 * by those names. A sports market is `["Team A", "Team B"]`, where "yes" is
 * meaningless and guessing would pick a side at random.
 */
export function resolveOutcome(market: PolymarketMarket, wanted: string): ResolvedOutcome {
  const outcomes = market.outcomes ?? [];
  const tokenIds = market.token_ids ?? [];

  if (outcomes.length === 0 || tokenIds.length === 0) {
    throw new OrderError(`Market ${market.ticker} exposes no tradeable outcomes.`);
  }
  if (outcomes.length !== tokenIds.length) {
    // Positional matching is the whole risk here; refuse rather than guess.
    throw new OrderError(
      `Market ${market.ticker} has ${outcomes.length} outcomes but ${tokenIds.length} token ids. ` +
        'Refusing to guess which is which.',
    );
  }

  const needle = wanted.trim().toLowerCase();
  let index = outcomes.findIndex((o) => o.toLowerCase() === needle);

  if (index === -1) {
    const prefixed = outcomes
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.toLowerCase().startsWith(needle));
    if (prefixed.length === 1) index = prefixed[0]!.i;
    else if (prefixed.length > 1) {
      throw new OrderError(
        `"${wanted}" matches more than one outcome on ${market.ticker}: ` +
          `${prefixed.map(({ o }) => o).join(', ')}. Use the full name.`,
      );
    }
  }

  if (index === -1) {
    throw new OrderError(
      `"${wanted}" is not an outcome of ${market.ticker}. Available: ${outcomes.join(', ')}.`,
    );
  }

  return { label: outcomes[index]!, tokenId: tokenIds[index]!, index };
}

/** The price a taker would actually get on this side right now. */
export function executablePrice(market: PolymarketMarket, outcomeIndex: number, action: TradeAction): number | null {
  // Book fields are quoted from the YES side; the complement is 1 - price.
  const isFirst = outcomeIndex === 0;
  const ask = isFirst ? market.yes_ask : market.no_ask;
  const bid = isFirst ? market.yes_bid : market.no_bid;
  const price = action === 'buy' ? ask : bid;
  return Number.isFinite(price) && price > 0 && price < 1 ? price : null;
}

export interface BuiltOrder {
  signed: SignedOrder;
  orderType: OrderType;
  tokenId: string;
  outcomeLabel: string;
  side: OrderSide;
  shares: number;
  /** Price the order was built at — the limit, or the executable quote. */
  price: number;
  /** What this costs (buy) or realises (sell), before fees. */
  notionalUsd: number;
  isMarketOrder: boolean;
}

/**
 * Validate, price and sign. Does not submit — `postOrder` does that, so a
 * caller can show the user exactly what will be sent before anything is.
 */
export async function buildOrder(req: OrderRequest): Promise<BuiltOrder> {
  const { market, action, shares } = req;
  const resolved = resolveOutcome(market, req.outcome);

  const minSize = Number.isFinite(market.min_order_size) ? market.min_order_size : 0;
  if (minSize > 0 && shares < minSize) {
    throw new OrderError(
      `${shares} shares is below the ${minSize}-share minimum for ${market.ticker}.`,
    );
  }

  const quote = executablePrice(market, resolved.index, action);
  const isMarketOrder = req.limitPrice === undefined;

  if (isMarketOrder && quote === null) {
    throw new OrderError(
      `No ${action === 'buy' ? 'ask' : 'bid'} available for ${resolved.label} on ${market.ticker}, ` +
        'so a market order has no price to execute against. Give a limit price instead.',
    );
  }

  const tick = Number.isFinite(market.tick_size) && market.tick_size > 0 ? market.tick_size : 0.01;
  // Snap the quote too: Gamma derives one side from the other, so a price
  // arrives as 0.04700000000000004 and carries that noise into the signature.
  const price = roundToTick(isMarketOrder ? quote! : req.limitPrice!, tick);

  if (price <= 0 || price >= 1) {
    throw new OrderError(
      `Price ${price} is outside the tradeable range. Prices are decimal USD in (0, 1).`,
    );
  }

  const estimatedUsd = shares * price;
  if (isMarketOrder && action === 'buy' && estimatedUsd < MIN_MARKET_BUY_USD) {
    const needed = Math.ceil(MIN_MARKET_BUY_USD / price);
    throw new OrderError(
      `${shares} shares of ${resolved.label} at $${price.toFixed(3)} is $${estimatedUsd.toFixed(2)}, ` +
        `and a market buy must be worth at least $${MIN_MARKET_BUY_USD}. ` +
        `Buy ${needed} or more shares, or set a limit price instead.`,
    );
  }

  const client = await getClobClient();
  const side = action === 'buy' ? OrderSide.BUY : OrderSide.SELL;

  let signed: SignedOrder;
  let orderType: OrderType;

  if (isMarketOrder) {
    // No price bound is passed. Supplying one opts into the SDK's "protected"
    // path, which signs the order AT the bound rather than at the book — and
    // pins it to our quote, which comes from a Gamma snapshot. Left alone, the
    // SDK fetches the live order book and walks it for the requested size,
    // which is both the right price and the real protection: a $50 order walks
    // to the depth that can fill it instead of failing against a single level.
    //
    // A buy is denominated in dollars, so the quote is still needed to turn the
    // user's share count into one. What gets signed is then read back below, so
    // the confirmation shows the venue's price rather than our estimate of it.
    signed =
      side === OrderSide.BUY
        ? await client.createMarketOrder({
            assetId: resolved.tokenId,
            side: OrderSide.BUY,
            amount: estimatedUsd,
            orderType: OrderType.FOK,
          })
        : await client.createMarketOrder({
            assetId: resolved.tokenId,
            side: OrderSide.SELL,
            shares,
            orderType: OrderType.FOK,
          });
    orderType = OrderType.FOK;
  } else {
    signed = await client.createLimitOrder({ assetId: resolved.tokenId, price, size: shares, side });
    orderType = OrderType.GTC;
  }

  // A limit order is exactly what was asked for. A market order is whatever the
  // book priced, which is rarely the share count the user typed: a dollar
  // amount does not divide evenly into shares.
  const filled = isMarketOrder ? legs(signed, side) : { shares, usd: shares * price };
  const signedPrice = filled.shares > 0 ? filled.usd / filled.shares : price;

  return {
    signed,
    orderType,
    tokenId: resolved.tokenId,
    outcomeLabel: resolved.label,
    side,
    shares: filled.shares,
    price: signedPrice,
    notionalUsd: filled.usd,
    isMarketOrder,
  };
}

export interface PostedOrder {
  orderId: string | null;
  status: string;
  /** Shares that matched immediately. 0 for an order that rests. */
  filledShares: number;
  raw: unknown;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Submit a signed order.
 *
 * `makingAmount` is what the order gave up and `takingAmount` what it received,
 * so which one is denominated in shares flips with the side: a buy receives
 * shares, a sell gives them up. Reading the same field for both reports a
 * dollar amount as a share count on every sell.
 */
export async function postOrder(built: BuiltOrder): Promise<PostedOrder> {
  const client = await getClobClient();
  const raw: OrderResponse = await client.postOrder(built.signed);

  // The CLOB reports refusal in-band; a 200 that is not `ok` is a rejection.
  if (!raw.ok) {
    // The venue cannot tell these two apart, and neither can we without a round
    // trip nobody asked for — but both have the same fix, so name both.
    const hint =
      raw.code === 'insufficient_balance_or_allowance'
        ? ' The wallet is either short of pUSD, or has not granted the on-chain approvals trading' +
          ' needs. Both are fixed on polymarket.com — deposit there, or place one trade there to be' +
          ' prompted for the approvals.'
        : '';
    throw new OrderError(`Order rejected: ${raw.message || raw.code || 'no reason given'}.${hint}`);
  }

  return {
    orderId: raw.orderId ?? null,
    status: String(raw.status ?? 'unknown'),
    filledShares: num(built.side === OrderSide.BUY ? raw.takingAmount : raw.makingAmount),
    raw,
  };
}
