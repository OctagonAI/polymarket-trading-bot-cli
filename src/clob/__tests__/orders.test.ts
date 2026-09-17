import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { OrderSide, OrderType } from '@polymarket/client';
import { resolveOutcome, executablePrice, buildOrder, postOrder, OrderError } from '../orders.js';
import * as client from '../client.js';
import type { PolymarketMarket } from '../../tools/polymarket/types.js';

/**
 * The three ways an order goes wrong expensively: the wrong token, the wrong
 * interpretation of `amount`, and an off-tick price.
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function market(over: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    ticker: 'will-btc-hit-100k',
    condition_id: `0x${'a'.repeat(64)}`,
    event_ticker: 'btc-2026',
    token_ids: ['tok-yes', 'tok-no'],
    outcomes: ['Yes', 'No'],
    title: 'Will BTC hit 100k',
    status: 'active',
    yes_bid: 0.4,
    yes_ask: 0.42,
    no_bid: 0.58,
    no_ask: 0.6,
    volume_24h: 10_000,
    tick_size: 0.01,
    min_order_size: 5,
    neg_risk: false,
    ...over,
  } as PolymarketMarket;
}

let captured: { marketOrder?: Record<string, unknown>; limitOrder?: Record<string, unknown> } = {};

const UNITS = 1_000_000;

/**
 * A market order is priced by the venue, so the stub has to answer like one:
 * `buildOrder` reads the signed legs back to learn the real price and size.
 * `bookPrice` is what the pretend book clears at.
 */
function stubClob(post?: Record<string, unknown>, bookPrice?: number) {
  captured = {};
  spies.push(
    spyOn(client, 'getClobClient').mockImplementation(async () => ({
      createMarketOrder: async (o: Record<string, unknown>) => {
        captured.marketOrder = o;
        const price = bookPrice ?? 0.42;
        const usd = o.side === 'BUY' ? Number(o.amount) : Number(o.shares) * price;
        const sh = o.side === 'BUY' ? usd / price : Number(o.shares);
        return {
          makerAmount: String(Math.round((o.side === 'BUY' ? usd : sh) * UNITS)),
          takerAmount: String(Math.round((o.side === 'BUY' ? sh : usd) * UNITS)),
        } as never;
      },
      createLimitOrder: async (o: Record<string, unknown>) => {
        captured.limitOrder = o;
        return { signed: true } as never;
      },
      postOrder: async () => post ?? { ok: true, orderId: '0xorder', status: 'matched' },
    }) as never),
  );
}

describe('resolveOutcome — picking the right token', () => {
  test('matches by label, not by position', () => {
    // The market below lists No first. Indexing positionally would buy No when
    // the user asked for Yes, and the order would succeed.
    const m = market({ outcomes: ['No', 'Yes'], token_ids: ['tok-no', 'tok-yes'] });
    expect(resolveOutcome(m, 'yes')).toMatchObject({ label: 'Yes', tokenId: 'tok-yes', index: 1 });
    expect(resolveOutcome(m, 'no')).toMatchObject({ label: 'No', tokenId: 'tok-no', index: 0 });
  });

  test('handles non-binary markets by name', () => {
    const m = market({ outcomes: ['Arsenal', 'Chelsea'], token_ids: ['tok-a', 'tok-c'] });
    expect(resolveOutcome(m, 'chelsea').tokenId).toBe('tok-c');
    expect(resolveOutcome(m, 'Ars').tokenId).toBe('tok-a');
  });

  test('"yes" on a market with no Yes outcome is refused, not guessed', () => {
    const m = market({ outcomes: ['Arsenal', 'Chelsea'], token_ids: ['tok-a', 'tok-c'] });
    expect(() => resolveOutcome(m, 'yes')).toThrow(/not an outcome/);
  });

  test('an ambiguous prefix is refused rather than resolved arbitrarily', () => {
    const m = market({ outcomes: ['Manchester United', 'Manchester City'], token_ids: ['u', 'c'] });
    expect(() => resolveOutcome(m, 'man')).toThrow(/matches more than one/);
  });

  test('mismatched outcomes and token ids are refused', () => {
    const m = market({ outcomes: ['Yes', 'No'], token_ids: ['only-one'] });
    expect(() => resolveOutcome(m, 'yes')).toThrow(/Refusing to guess/);
  });
});

describe('executablePrice', () => {
  test('a buy pays the ask and a sell hits the bid, per side', () => {
    const m = market();
    expect(executablePrice(m, 0, 'buy')).toBe(0.42);
    expect(executablePrice(m, 0, 'sell')).toBe(0.4);
    expect(executablePrice(m, 1, 'buy')).toBe(0.6);
    expect(executablePrice(m, 1, 'sell')).toBe(0.58);
  });

  test('an absent quote is null rather than zero', () => {
    expect(executablePrice(market({ yes_ask: 0 }), 0, 'buy')).toBeNull();
  });
});

describe('buildOrder — market orders', () => {
  test('a market BUY converts shares to dollars', async () => {
    // amount is $$$ for a buy and shares for a sell. Passing 50 straight
    // through would spend $50 where the user asked for 50 shares.
    stubClob();
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });

    // No maxPrice: supplying one signs the order AT the bound instead of at
    // the book, and pins it to a Gamma snapshot. The venue walks its own book.
    expect(captured.marketOrder).toMatchObject({ assetId: 'tok-yes', side: OrderSide.BUY });
    expect(captured.marketOrder!.maxPrice).toBeUndefined();
    expect(captured.marketOrder!.amount).toBeCloseTo(21, 6); // 50 × 0.42
    expect(built.orderType).toBe(OrderType.FOK);
    expect(built.notionalUsd).toBeCloseTo(21, 6);
  });

  test('a market SELL passes shares through unconverted', async () => {
    stubClob();
    await buildOrder({ market: market(), action: 'sell', outcome: 'yes', shares: 50 });
    expect(captured.marketOrder).toMatchObject({ shares: 50, side: OrderSide.SELL });
    expect(captured.marketOrder!.minPrice).toBeUndefined();
  });

  test('no quote on the side means no market order', async () => {
    stubClob();
    await expect(
      buildOrder({ market: market({ yes_ask: 0 }), action: 'buy', outcome: 'yes', shares: 50 }),
    ).rejects.toThrow(/market order has no price/);
  });
});

describe('buildOrder — the venue prices a market order', () => {
  test('price and size come back from what was signed, not from our quote', async () => {
    // The book clears deeper than the top-of-book quote, which is exactly the
    // case our own pricing got wrong: it would have promised 0.42 and signed an
    // order that could not fill.
    stubClob(undefined, 0.45);
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });

    // Quote said 0.42, so we asked the venue for $21 of it.
    expect(captured.marketOrder!.amount).toBeCloseTo(21, 6);
    // The venue filled at 0.45, so that is the price and size reported.
    expect(built.price).toBeCloseTo(0.45, 6);
    expect(built.shares).toBeCloseTo(21 / 0.45, 4);
    expect(built.notionalUsd).toBeCloseTo(21, 6);
  });

  test('a sell reports the proceeds the venue priced', async () => {
    stubClob(undefined, 0.38);
    const built = await buildOrder({ market: market(), action: 'sell', outcome: 'yes', shares: 50 });

    expect(built.shares).toBeCloseTo(50, 6);
    expect(built.price).toBeCloseTo(0.38, 6);
    expect(built.notionalUsd).toBeCloseTo(19, 6);
  });

  test('a float artefact in the quote is snapped to the tick before it is used', async () => {
    // Gamma derives one side from the other, so a price arrives as
    // 0.04700000000000004 and that noise would ride into the dollar amount.
    stubClob(undefined, 0.047);
    const built = await buildOrder({
      market: market({ no_ask: 0.04700000000000004, tick_size: 0.001, min_order_size: 1 }),
      action: 'buy',
      outcome: 'no',
      shares: 25,
    });
    expect(captured.marketOrder!.amount).toBeCloseTo(25 * 0.047, 9);
    expect(built.price).toBeCloseTo(0.047, 6);
  });

  test('a limit order is still exactly what was asked for', async () => {
    stubClob();
    const built = await buildOrder({
      market: market(), action: 'buy', outcome: 'yes', shares: 50, limitPrice: 0.42,
    });
    expect(built.shares).toBe(50);
    expect(built.price).toBe(0.42);
    expect(built.notionalUsd).toBeCloseTo(21, 6);
  });
});

describe('buildOrder — limit orders', () => {
  test('a limit price is rounded to the market tick before signing', async () => {
    // An off-tick price is rejected by the venue, so rounding has to happen
    // before the signature, not after.
    stubClob();
    const built = await buildOrder({
      market: market({ tick_size: 0.01 }),
      action: 'buy',
      outcome: 'yes',
      shares: 50,
      limitPrice: 0.4267,
    });
    expect(captured.limitOrder).toMatchObject({ price: 0.43, size: 50, side: OrderSide.BUY });
    expect(built.orderType).toBe(OrderType.GTC);
  });

  test('size is shares for a limit order on both sides', async () => {
    stubClob();
    await buildOrder({ market: market(), action: 'sell', outcome: 'no', shares: 12.5, limitPrice: 0.6 });
    expect(captured.limitOrder).toMatchObject({ assetId: 'tok-no', size: 12.5, side: OrderSide.SELL });
  });

  test('a price outside (0,1) is refused', async () => {
    stubClob();
    await expect(
      buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50, limitPrice: 1 }),
    ).rejects.toThrow(/tradeable range/);
  });
});

describe('buildOrder — venue minimum', () => {
  test('below the market minimum is refused before signing', async () => {
    stubClob();
    await expect(
      buildOrder({ market: market({ min_order_size: 5 }), action: 'buy', outcome: 'yes', shares: 2 }),
    ).rejects.toThrow(/below the 5-share minimum/);
  });

  test('a market buy worth under a dollar is refused, and says what would work', async () => {
    // The two minimums disagree on a cheap outcome: five shares clears a
    // five-share minimum and is still $0.24. The venue calls this "min size: 1",
    // which reads like one share when it means one dollar.
    stubClob();
    const cheap = market({ min_order_size: 5, no_ask: 0.047, tick_size: 0.001 });
    await expect(
      buildOrder({ market: cheap, action: 'buy', outcome: 'no', shares: 5 }),
    ).rejects.toThrow(/must be worth at least \$1.*Buy 22 or more shares/s);
  });

  test('a market buy over a dollar is built', async () => {
    stubClob();
    const built = await buildOrder({
      market: market({ min_order_size: 5, no_ask: 0.047, tick_size: 0.001 }),
      action: 'buy',
      outcome: 'no',
      shares: 22,
    });
    expect(built.notionalUsd).toBeGreaterThanOrEqual(1);
  });

  test('the dollar minimum does not apply to a limit order', async () => {
    // It binds on marketable buys. A resting limit is not one, and blocking it
    // here would refuse an order the venue would have accepted.
    stubClob();
    const built = await buildOrder({
      market: market({ min_order_size: 5, no_ask: 0.047, tick_size: 0.001 }),
      action: 'buy',
      outcome: 'no',
      shares: 5,
      limitPrice: 0.02,
    });
    expect(built.notionalUsd).toBeLessThan(1);
  });

  test('a small market sell is left to the venue to judge', async () => {
    // A sell is denominated in shares, and nothing observed says the dollar
    // minimum applies to it. Guessing would refuse valid orders.
    stubClob(undefined, 0.046);
    const built = await buildOrder({
      market: market({ min_order_size: 5, no_bid: 0.046 }),
      action: 'sell',
      outcome: 'no',
      shares: 5,
    });
    expect(built.notionalUsd).toBeLessThan(1);
  });
});

describe('postOrder', () => {
  test('an in-band rejection is an error, not a placed order', async () => {
    // The CLOB answers 200 with ok:false. Treating that as placed would
    // report a trade that never happened.
    stubClob({ ok: false, code: 'insufficient_balance_or_allowance', message: 'not enough balance' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    await expect(postOrder(built)).rejects.toThrow(/not enough balance/);
  });

  test('a successful post reports the order id and what matched', async () => {
    stubClob({ ok: true, orderId: '0xabc', status: 'matched', takingAmount: '50', makingAmount: '21' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    const posted = await postOrder(built);

    expect(posted.orderId).toBe('0xabc');
    expect(posted.filledShares).toBe(50);
  });

  test('a balance-or-allowance refusal says where both are fixed', async () => {
    // This replaced an 11-call on-chain pre-flight before every order. The
    // venue cannot separate the two causes, so the message must name both.
    stubClob({ ok: false, code: 'insufficient_balance_or_allowance', message: 'not enough balance' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    await expect(postOrder(built)).rejects.toThrow(/polymarket\.com/);
  });

  test('an unrelated rejection gets no balance advice', async () => {
    stubClob({ ok: false, code: 'post_only_would_cross', message: 'would cross' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    await expect(postOrder(built)).rejects.toThrow(/would cross/);
    await expect(postOrder(built)).rejects.not.toThrow(/polymarket\.com/);
  });

  test('a sell reads its share count from the maker leg', async () => {
    // A sell gives up shares and receives dollars, so takingAmount is USD here.
    // Reading it as the fill would record 21 shares sold instead of 50.
    stubClob({ ok: true, orderId: '0xsell', status: 'matched', makingAmount: '50', takingAmount: '21' });
    const built = await buildOrder({ market: market(), action: 'sell', outcome: 'yes', shares: 50 });
    expect((await postOrder(built)).filledShares).toBe(50);
  });

  test('a resting order reports zero filled', async () => {
    stubClob({ ok: true, orderId: '0xrest', status: 'live' });
    const built = await buildOrder({
      market: market(), action: 'buy', outcome: 'yes', shares: 50, limitPrice: 0.2,
    });
    expect((await postOrder(built)).filledShares).toBe(0);
  });
});
