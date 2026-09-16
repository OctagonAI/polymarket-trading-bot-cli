/**
 * Turning "buy 50 shares of this market's Yes at 0.42" into a signed CLOB order.
 *
 * Three things here are easy to get wrong and expensive when you do:
 *
 *  1. **Which token.** `token_ids` is parallel to `outcomes`, so the side is
 *     resolved by matching the outcome LABEL. Indexing positionally — assuming
 *     0 is Yes — silently buys the opposite side of the trade, and the order
 *     succeeds, so nothing surfaces the mistake until the market resolves.
 *  2. **What `amount` means.** `UserMarketOrder.amount` is dollars for a BUY and
 *     shares for a SELL. This CLI takes shares in both cases, so a market buy
 *     converts shares → dollars at the executable price. Passing shares straight
 *     through would spend $50 where the user asked for 50 shares.
 *  3. **Tick size.** A price off-tick is rejected by the venue, so limit prices
 *     are rounded to the market's tick before signing.
 */
import { Side, OrderType, type SignedOrder } from '@polymarket/clob-client';
import { getClobClient } from './client.js';
import { roundToTick } from '../tools/polymarket/api.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';

export type TradeAction = 'buy' | 'sell';

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
  side: Side;
  shares: number;
  /** Price the order was built at — the limit, or the executable quote. */
  price: number;
  /** shares × price. What this costs (buy) or realises (sell), before fees. */
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
  const price = isMarketOrder ? quote! : roundToTick(req.limitPrice!, tick);

  if (price <= 0 || price >= 1) {
    throw new OrderError(
      `Price ${price} is outside the tradeable range. Prices are decimal USD in (0, 1).`,
    );
  }

  const client = await getClobClient();
  const side = action === 'buy' ? Side.BUY : Side.SELL;

  let signed: SignedOrder;
  let orderType: OrderType;

  if (isMarketOrder) {
    // amount is DOLLARS for a buy and SHARES for a sell. See the file header.
    const amount = action === 'buy' ? shares * price : shares;
    signed = await client.createMarketOrder({ tokenID: resolved.tokenId, amount, side, price });
    orderType = OrderType.FOK;
  } else {
    signed = await client.createOrder({ tokenID: resolved.tokenId, price, size: shares, side });
    orderType = OrderType.GTC;
  }

  return {
    signed,
    orderType,
    tokenId: resolved.tokenId,
    outcomeLabel: resolved.label,
    side,
    shares,
    price,
    notionalUsd: shares * price,
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

/** Submit a signed order. */
export async function postOrder(built: BuiltOrder): Promise<PostedOrder> {
  const client = await getClobClient();
  const raw = (await client.postOrder(built.signed, built.orderType)) as Record<string, unknown>;

  // The CLOB reports success in-band; a 200 with success:false is a rejection.
  if (raw && raw.success === false) {
    throw new OrderError(
      `Order rejected: ${String(raw.errorMsg ?? raw.error ?? 'no reason given')}`,
    );
  }

  return {
    orderId: typeof raw?.orderID === 'string' ? raw.orderID : null,
    status: String(raw?.status ?? 'unknown'),
    filledShares: num(raw?.takingAmount ?? raw?.size_matched),
    raw,
  };
}
