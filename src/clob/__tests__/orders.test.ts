import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { Side, OrderType } from '@polymarket/clob-client';
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

function stubClob(post?: Record<string, unknown>) {
  captured = {};
  spies.push(
    spyOn(client, 'getClobClient').mockImplementation(async () => ({
      createMarketOrder: async (o: Record<string, unknown>) => {
        captured.marketOrder = o;
        return { signed: true } as never;
      },
      createOrder: async (o: Record<string, unknown>) => {
        captured.limitOrder = o;
        return { signed: true } as never;
      },
      postOrder: async () => post ?? { success: true, orderID: '0xorder', status: 'matched' },
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

    expect(captured.marketOrder).toMatchObject({ tokenID: 'tok-yes', side: Side.BUY, price: 0.42 });
    expect(captured.marketOrder!.amount).toBeCloseTo(21, 6); // 50 × 0.42
    expect(built.orderType).toBe(OrderType.FOK);
    expect(built.notionalUsd).toBeCloseTo(21, 6);
  });

  test('a market SELL passes shares through unconverted', async () => {
    stubClob();
    await buildOrder({ market: market(), action: 'sell', outcome: 'yes', shares: 50 });
    expect(captured.marketOrder).toMatchObject({ amount: 50, side: Side.SELL, price: 0.4 });
  });

  test('no quote on the side means no market order', async () => {
    stubClob();
    await expect(
      buildOrder({ market: market({ yes_ask: 0 }), action: 'buy', outcome: 'yes', shares: 50 }),
    ).rejects.toThrow(/market order has no price/);
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
    expect(captured.limitOrder).toMatchObject({ price: 0.43, size: 50, side: Side.BUY });
    expect(built.orderType).toBe(OrderType.GTC);
  });

  test('size is shares for a limit order on both sides', async () => {
    stubClob();
    await buildOrder({ market: market(), action: 'sell', outcome: 'no', shares: 12.5, limitPrice: 0.6 });
    expect(captured.limitOrder).toMatchObject({ tokenID: 'tok-no', size: 12.5, side: Side.SELL });
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
});

describe('postOrder', () => {
  test('an in-band rejection is an error, not a placed order', async () => {
    // The CLOB answers 200 with success:false. Treating that as placed would
    // report a trade that never happened.
    stubClob({ success: false, errorMsg: 'not enough balance' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    await expect(postOrder(built)).rejects.toThrow(/not enough balance/);
  });

  test('a successful post reports the order id and what matched', async () => {
    stubClob({ success: true, orderID: '0xabc', status: 'matched', takingAmount: '50' });
    const built = await buildOrder({ market: market(), action: 'buy', outcome: 'yes', shares: 50 });
    const posted = await postOrder(built);

    expect(posted.orderId).toBe('0xabc');
    expect(posted.filledShares).toBe(50);
  });

  test('a resting order reports zero filled', async () => {
    stubClob({ success: true, orderID: '0xrest', status: 'live' });
    const built = await buildOrder({
      market: market(), action: 'buy', outcome: 'yes', shares: 50, limitPrice: 0.2,
    });
    expect((await postOrder(built)).filledShares).toBe(0);
  });
});
