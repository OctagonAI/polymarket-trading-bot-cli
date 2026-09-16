import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createDb } from '../../db/index.js';
import { getOpenPositions, openPosition, reducePosition } from '../../db/positions.js';
import { getRecentTrades } from '../../db/trades.js';
import { insertRiskSnapshot } from '../../db/risk.js';
import { parseArgs } from '../parse-args.js';
import * as identity from '../../wallet/identity.js';
import * as approvals from '../../chain/approvals.js';
import * as orders from '../../clob/orders.js';
import * as analyze from '../analyze.js';
import * as dbModule from '../../db/index.js';
import type { PolymarketMarket } from '../../tools/polymarket/types.js';
import type { ApprovalStatus } from '../../chain/approvals.js';

/**
 * The guards in front of an order, and what gets written after one fills.
 */

const PROXY = '0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563';
const SIGNER = '0xF2B909e5E2cBc2CFF2d07E02c9b1bAFd0B3A86a2';
const spies: Array<{ mockRestore: () => void }> = [];
let db: Database;

beforeEach(() => {
  db = createDb(':memory:');
  spies.push(spyOn(dbModule, 'getDb').mockImplementation(() => db));
});

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
    title: 'BTC',
    status: 'active',
    yes_bid: 0.4, yes_ask: 0.42, no_bid: 0.58, no_ask: 0.6,
    volume_24h: 10_000, tick_size: 0.01, min_order_size: 1, neg_risk: false,
    ...over,
  } as PolymarketMarket;
}

const approved = (): ApprovalStatus[] => [
  { target: 'CTF Exchange', kind: 'collateral', spender: '0x1', approved: true, required: true, allowance: 1e9 },
];

function setup(opts: {
  tier?: identity.WalletTier;
  statuses?: ApprovalStatus[];
  filled?: number;
  orderId?: string;
} = {}) {
  const tier = opts.tier ?? 'trade';
  const built = {
    signed: {} as never,
    orderType: 'GTC' as never,
    tokenId: 'tok-yes',
    outcomeLabel: 'Yes',
    side: 'BUY' as never,
    shares: 50,
    price: 0.42,
    notionalUsd: 21,
    isMarketOrder: false,
  };
  const postSpy = spyOn(orders, 'postOrder').mockImplementation(async () => ({
    orderId: opts.orderId ?? '0xorder',
    status: 'matched',
    filledShares: opts.filled ?? 50,
    raw: {},
  }));
  spies.push(
    spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
      tier, address: PROXY, ...(tier === 'trade' ? { signer: SIGNER } : {}), source: 'file' as const,
    })),
    spyOn(approvals, 'checkApprovals').mockImplementation(async () => opts.statuses ?? approved()),
    spyOn(analyze, 'resolveMarket').mockImplementation(async () => market()),
    spyOn(orders, 'buildOrder').mockImplementation(async () => built as never),
    postSpy,
  );
  return postSpy;
}

async function run(argv: string[]) {
  const { handleTrade } = await import('../trade.js');
  return handleTrade(argv[0] as 'buy' | 'sell', parseArgs(argv));
}

describe('trade — guards before an order', () => {
  test('a watch-only wallet cannot place', async () => {
    const post = setup({ tier: 'watch' });
    const resp = await run(['buy', 'slug', '50', '0.42', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('NO_KEY');
    expect(post).not.toHaveBeenCalled();
  });

  test('missing approvals name the command that fixes them', async () => {
    const post = setup({
      statuses: [{ ...approved()[0]!, approved: false }],
    });
    const resp = await run(['buy', 'slug', '50', '0.42', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('NOT_APPROVED');
    expect(resp.error?.message).toContain('wallet approve');
    expect(post).not.toHaveBeenCalled();
  });

  test('an active circuit breaker is a hard stop', async () => {
    // This is the limit the user set to stop themselves after a bad run;
    // walking past it by default would defeat the only mechanism here designed
    // to override its operator.
    const post = setup();
    insertRiskSnapshot(db, { timestamp: Math.floor(Date.now() / 1000), daily_pnl: -5000, equity: 100 });
    const resp = await run(['buy', 'slug', '50', '0.42', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('CIRCUIT_BREAKER');
    expect(resp.error?.message).toContain('--force');
    expect(post).not.toHaveBeenCalled();
  });

  test('--force overrides the breaker but records that it was overridden', async () => {
    const post = setup();
    insertRiskSnapshot(db, { timestamp: Math.floor(Date.now() / 1000), daily_pnl: -5000, equity: 100 });
    const resp = await run(['buy', 'slug', '50', '0.42', '--yes', '--force']);

    expect(resp.ok).toBe(true);
    expect(resp.data.warnings.join(' ')).toContain('Circuit breaker overridden');
    expect(post).toHaveBeenCalled();
  });

  test('nothing is placed in a non-TTY without --yes', async () => {
    const post = setup();
    const wasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const resp = await run(['buy', 'slug', '50', '0.42']);
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('CANCELLED');
      expect(post).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });

  test('a bad share count is rejected before any network call', async () => {
    const post = setup();
    const resp = await run(['buy', 'slug', '-5', '--yes']);
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INVALID_ARG');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('trade — argument shape', () => {
  test('price and outcome are recognised by shape, in either order', async () => {
    const buildSpy = spyOn(orders, 'buildOrder');
    setup();
    await run(['buy', 'slug', '50', '0.42', 'no', '--yes']);
    expect(buildSpy.mock.calls[0]![0]).toMatchObject({ outcome: 'no', limitPrice: 0.42 });

    buildSpy.mockClear();
    await run(['buy', 'slug', '50', 'no', '--yes']);
    // No price token: a market order on the No side, not a limit at NaN.
    expect(buildSpy.mock.calls[0]![0]).toMatchObject({ outcome: 'no' });
    expect(buildSpy.mock.calls[0]![0].limitPrice).toBeUndefined();
  });
});

describe('trade — what gets written', () => {
  test('a filled buy opens a position and logs the trade', async () => {
    setup({ filled: 50 });
    const resp = await run(['buy', 'slug', '50', '0.42', '--yes']);
    expect(resp.ok).toBe(true);

    const positions = getOpenPositions(db);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ ticker: 'will-btc-hit-100k', direction: 'Yes', size: 50 });
    expect(getRecentTrades(db, 10)).toHaveLength(1);
  });

  test('a resting limit order is not a position', async () => {
    // Writing an unfilled order as a position would inflate the concentration
    // and correlation checks with exposure that does not exist.
    setup({ filled: 0 });
    const resp = await run(['buy', 'slug', '50', '0.20', '--yes']);

    expect(resp.ok).toBe(true);
    expect(resp.data.filledShares).toBe(0);
    expect(getOpenPositions(db)).toHaveLength(0);
  });

  test('only the matched portion is recorded', async () => {
    setup({ filled: 20 });
    await run(['buy', 'slug', '50', '0.42', '--yes']);
    expect(getOpenPositions(db)[0]!.size).toBe(20);
  });

  test('a sell reduces the holding rather than closing it outright', async () => {
    setup({ filled: 30 });
    openPosition(db, {
      position_id: 'p1', ticker: 'will-btc-hit-100k', event_ticker: 'btc-2026',
      direction: 'Yes', size: 50, entry_price: 0.4, opened_at: 1, status: 'open',
    });

    await run(['sell', 'slug', '30', '0.45', '--yes']);
    const open = getOpenPositions(db);
    expect(open).toHaveLength(1);
    expect(open[0]!.size).toBe(20);
  });

  test('selling the whole holding closes it', async () => {
    setup({ filled: 50 });
    openPosition(db, {
      position_id: 'p1', ticker: 'will-btc-hit-100k', event_ticker: 'btc-2026',
      direction: 'Yes', size: 50, entry_price: 0.4, opened_at: 1, status: 'open',
    });

    await run(['sell', 'slug', '50', '0.45', '--yes']);
    expect(getOpenPositions(db)).toHaveLength(0);
  });
});

describe('reducePosition', () => {
  beforeEach(() => {
    openPosition(db, {
      position_id: 'p1', ticker: 't', event_ticker: 'e',
      direction: 'Yes', size: 10, entry_price: 0.5, opened_at: 1, status: 'open',
    });
  });

  test('a partial reduction keeps the position open', () => {
    reducePosition(db, 'p1', 4, 2);
    expect(getOpenPositions(db)[0]!.size).toBe(6);
  });

  test('floating-point dust still closes the position', () => {
    // 10 - 9.9999999 is not 0, but it is not a position either.
    reducePosition(db, 'p1', 9.9999999, 2);
    expect(getOpenPositions(db)).toHaveLength(0);
  });

  test('reducing an unknown position is a no-op, not a crash', () => {
    expect(() => reducePosition(db, 'nope', 1, 2)).not.toThrow();
  });
});
