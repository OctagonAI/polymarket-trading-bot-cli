import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createDb } from '../../db/index.js';
import { openPosition } from '../../db/positions.js';
import { upsertEvent } from '../../db/events.js';
import { insertRiskSnapshot } from '../../db/risk.js';
import type { PolymarketMarket } from '../../tools/polymarket/types.js';
import type { KellyResult } from '../kelly.js';
import { kellySize, fetchLiveBankroll } from '../kelly.js';
import { riskGate } from '../gate.js';
import { getCorrelationByCategory, isCorrelated } from '../correlation.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import * as polyPortfolio from '../../tools/polymarket/portfolio.js';
import * as botConfig from '../../utils/bot-config.js';
import * as erc20 from '../../chain/erc20.js';
import { resetWalletIdentityCache } from '../../wallet/identity.js';

// --- Mock the Data API portfolio reads and the configured bankroll ---
// Polymarket exposes no cash balance, so kelly reads `risk.bankroll_usdc`.

let mockBankrollUsdc = 0;
let mockPositions: Array<{ current_value: number }> = [];
/** On-chain free pUSD. null means unreadable, which is not the same as zero. */
let mockWalletCash: number | null = null;
const spies: Array<{ mockRestore: () => void }> = [];

const TEST_WALLET = '0x' + '1'.repeat(40);

function installApiMock() {
  // The wallet is stubbed in rather than set via env, so these tests exercise
  // the sizing maths regardless of what wallet the developer has configured.
  //
  // readPusdBalance MUST be stubbed too: with an address present,
  // fetchLiveBankroll reads the chain, and an unstubbed call would both hit the
  // network from a unit test and return ~0 for this fake address — which then
  // caps every size at zero.
  const realGetBotSetting = botConfig.getBotSetting;
  resetWalletIdentityCache();
  spies.push(
    spyOn(erc20, 'readPusdBalance').mockImplementation(async () => mockWalletCash),
    spyOn(polyPortfolio, 'getWalletAddress').mockImplementation(() => TEST_WALLET),
    spyOn(polyPortfolio, 'fetchPortfolioValue').mockImplementation(
      async () => ({ portfolio_value: mockBankrollUsdc, address: TEST_WALLET }),
    ),
    spyOn(polyPortfolio, 'fetchPositions').mockImplementation(
      async () => mockPositions as never,
    ),
    spyOn(botConfig, 'getBotSetting').mockImplementation((key: string) =>
      key === 'risk.bankroll_usdc' ? mockBankrollUsdc : realGetBotSetting(key),
    ),
  );
}

function restoreApiMock() {
  for (const spy of spies.splice(0)) spy.mockRestore();
  mockWalletCash = null;
  resetWalletIdentityCache();
}

// --- Helpers ---

/** Amounts are USDC. */
function setMockBankroll(balanceUsdc: number, _unused: number, positions: Array<{ current_value: number }>) {
  mockBankrollUsdc = balanceUsdc;
  mockPositions = positions;
}

function makeMarket(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    ticker: 'mkt-yes',
    condition_id: '0x' + 'a'.repeat(64),
    event_ticker: 'ev-1',
    token_ids: ['1', '2'],
    outcomes: ['Yes', 'No'],
    title: 'Test',
    subtitle: '',
    yes_sub_title: 'Yes',
    no_sub_title: 'No',
    status: 'active',
    open_time: '',
    close_time: '',
    expiration_time: '',
    // Decimal probabilities, not cents
    yes_bid: 0.50,
    yes_ask: 0.52,
    no_bid: 0.48,
    no_ask: 0.50,
    last_price: 0.51,
    previous_price: 0.51,
    volume: 5000,
    volume_24h: 3000,
    liquidity: 10000,
    open_interest: 2000,
    tick_size: 0.01,
    min_order_size: 5,
    neg_risk: false,
    accepting_orders: true,
    category: 'politics',
    result: '',
    ...overrides,
  } as PolymarketMarket;
}

function insertTestPosition(db: Database, overrides: Record<string, unknown> = {}): void {
  openPosition(db, {
    position_id: (overrides.position_id as string) ?? `pos-${Math.random().toString(36).slice(2)}`,
    ticker: (overrides.ticker as string) ?? 'MKT-YES',
    event_ticker: (overrides.event_ticker as string) ?? 'EV-1',
    direction: (overrides.direction as string) ?? 'buy_yes',
    size: (overrides.size as number) ?? 10,
    entry_price: (overrides.entry_price as number) ?? 55,
    entry_edge: (overrides.entry_edge as number) ?? 0.10,
    status: 'open',
    opened_at: Math.floor(Date.now() / 1000),
  });
}

// --- Tests ---

describe('Kelly Sizing', () => {
  beforeEach(() => {
    setMockBankroll(0, 0, []);
    installApiMock();
  });

  afterEach(() => {
    restoreApiMock();
  });

  test('computes correct size with $1000 bankroll, $300 exposure', async () => {
    setMockBankroll(1000, 0, [
      { current_value: 150 },
      { current_value: 150 },
    ]);

    const result = await kellySize({
      edge: 0.10,
      marketProb: 0.50,
    });

    // available = 1000 - 300 = 700
    expect(result.availableBankroll).toBe(700);
    expect(result.cashBalance).toBe(1000);
    expect(result.openExposure).toBe(300);
    expect(result.side).toBe('yes');

    // f* = 0.10 / (1 - 0.50) = 0.20
    expect(result.fraction).toBeCloseTo(0.20, 5);

    // half-Kelly: 0.20 * 0.5 = 0.10
    expect(result.adjustedFraction).toBeCloseTo(0.10, 5);

    // notional = 0.10 * 700 = $70, capped at 10% * 700 = $70 → same
    // entryPrice = marketProb = 0.50 (no market obj, uses midpoint fallback)
    // shares = floor((70 / 0.50) * 100) / 100 = 140
    expect(result.shares).toBe(140);
    expect(result.notionalUsdc).toBeCloseTo(70, 6);
    expect(result.liquidityAdjusted).toBe(false);
  });

  test('full-Kelly doubles the size vs half-Kelly', async () => {
    setMockBankroll(1000, 0, [{ current_value: 300 }]);

    const half = await kellySize({ edge: 0.10, marketProb: 0.50, multiplier: 0.5 });
    const full = await kellySize({ edge: 0.10, marketProb: 0.50, multiplier: 1.0 });

    // full-Kelly adjustedFraction should be double half-Kelly
    expect(full.adjustedFraction).toBeCloseTo(half.adjustedFraction * 2, 5);

    // But both are capped at maxPositionPct (10%) of bankroll
    // half: 0.10 * 70000 = 7000, cap = 7000 → 7000
    // full: 0.20 * 70000 = 14000, cap = 7000 → 7000
    // So contracts should be same due to cap
    expect(full.notionalUsdc).toBeLessThanOrEqual(full.availableBankroll * 0.10 + 1e-9);
  });

  test('liquidity adjustment caps size at 50% for wide spread', async () => {
    setMockBankroll(1000, 0, []);

    // 7¢ spread > the 3¢ liquidity threshold
    const market = makeMarket({ yes_bid: 0.48, yes_ask: 0.55 });

    const result = await kellySize({
      edge: 0.15,
      marketProb: 0.50,
      market,
    });

    expect(result.liquidityAdjusted).toBe(true);
    // With executable quote: edge vs ask (0.55) = (0.50+0.15)-0.55 = 0.10, fraction = 0.10/0.45 ≈ 0.2222
    // adjustedFraction = 0.2222 * 0.5 (half-Kelly) * 0.5 (liquidity) ≈ 0.0556
    expect(result.adjustedFraction).toBeCloseTo(0.0556, 3);
  });

  test('edge below threshold produces 0 shares with reason', async () => {
    setMockBankroll(1000, 0, []);

    const result = await kellySize({ edge: 0.01, marketProb: 0.50 });

    expect(result.shares).toBe(0);
    expect(result.skippedReason).toContain('threshold');
  });

  test('zero edge produces 0 shares', async () => {
    setMockBankroll(1000, 0, []);

    const result = await kellySize({ edge: 0, marketProb: 0.50 });

    expect(result.fraction).toBe(0);
    expect(result.shares).toBe(0);
    expect(result.notionalUsdc).toBe(0);
  });

  test('negative edge sizes NO shares', async () => {
    setMockBankroll(1000, 0, []);

    const result = await kellySize({ edge: -0.10, marketProb: 0.50 });

    expect(result.side).toBe('no');
    // f* = |edge| / marketProb = 0.10 / 0.50 = 0.20
    expect(result.fraction).toBeCloseTo(0.20, 5);
    expect(result.shares).toBeGreaterThan(0);
  });

  test('small negative edge below threshold produces 0 shares', async () => {
    setMockBankroll(1000, 0, []);

    const result = await kellySize({ edge: -0.01, marketProb: 0.50 });

    expect(result.side).toBe('no');
    expect(result.shares).toBe(0);
    expect(result.skippedReason).toContain('threshold');
  });
});

describe('Risk Gate', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(':memory:');
    setMockBankroll(0, 0, []);
  });

  function makeKelly(overrides: Partial<KellyResult> = {}): KellyResult {
    return {
      side: 'yes',
      fraction: 0.20,
      adjustedFraction: 0.10,
      shares: 10,
      notionalUsdc: 5,
      entryPrice: 0.50,
      availableBankroll: 700,
      openExposure: 300,
      cashBalance: 1000,
      portfolioValue: 100000,
      liquidityAdjusted: false,
      ...overrides,
    };
  }

  test('all checks pass for healthy setup', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });

    const result = riskGate({
      ticker: 'MKT-YES',
      eventTicker: 'EV-1',
      kelly: makeKelly(),
      market: makeMarket(),
      db,
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  test('fails when kelly produces 0 shares', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });

    const result = riskGate({
      ticker: 'MKT-YES',
      eventTicker: 'EV-1',
      kelly: makeKelly({ shares: 0, notionalUsdc: 0 }),
      market: makeMarket(),
      db,
    });

    expect(result.passed).toBe(false);
    const kellyCheck = result.checks.find((c) => c.name === 'kelly');
    expect(kellyCheck!.passed).toBe(false);
  });

  test('fails on wide spread', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });

    const result = riskGate({
      ticker: 'MKT-YES',
      eventTicker: 'EV-1',
      kelly: makeKelly(),
      market: makeMarket({ yes_bid: 0.45, yes_ask: 0.55 }), // 10¢ spread
      db,
    });

    expect(result.passed).toBe(false);
    const liqCheck = result.checks.find((c) => c.name === 'liquidity');
    expect(liqCheck!.passed).toBe(false);
  });

  test('fails when too many positions in same category', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-2', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-3', category: 'politics', active: 1 });

    // Open 3 positions in 'politics' category
    insertTestPosition(db, { position_id: 'p1', event_ticker: 'EV-1' });
    insertTestPosition(db, { position_id: 'p2', event_ticker: 'EV-2' });
    insertTestPosition(db, { position_id: 'p3', event_ticker: 'EV-3' });

    const result = riskGate({
      ticker: 'MKT-NEW',
      eventTicker: 'EV-1', // same category
      kelly: makeKelly(),
      market: makeMarket(),
      db,
    });

    expect(result.passed).toBe(false);
    const corrCheck = result.checks.find((c) => c.name === 'correlation');
    expect(corrCheck!.passed).toBe(false);
  });

  test('fails when too many total positions', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });

    // Insert maxTotalPositions positions
    for (let i = 0; i < 10; i++) {
      upsertEvent(db, { ticker: `EV-${i}`, category: `cat-${i}`, active: 1 });
      insertTestPosition(db, { position_id: `pos-${i}`, event_ticker: `EV-${i}` });
    }

    const result = riskGate({
      ticker: 'MKT-NEW',
      eventTicker: 'EV-1',
      kelly: makeKelly(),
      market: makeMarket(),
      db,
    });

    expect(result.passed).toBe(false);
    const concCheck = result.checks.find((c) => c.name === 'concentration');
    expect(concCheck!.passed).toBe(false);
  });

  test('fails when drawdown exceeds limit', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });

    insertRiskSnapshot(db, {
      timestamp: Math.floor(Date.now() / 1000),
      drawdown_current: 0.25, // 25% > 20% default max
    });

    const result = riskGate({
      ticker: 'MKT-YES',
      eventTicker: 'EV-1',
      kelly: makeKelly(),
      market: makeMarket(),
      db,
    });

    expect(result.passed).toBe(false);
    const ddCheck = result.checks.find((c) => c.name === 'drawdown');
    expect(ddCheck!.passed).toBe(false);
  });
});

describe('sizing from incomplete inputs', () => {
  test('a cap applied without exposure says so', async () => {
    // The cap is a ceiling on deployed capital, so it only means anything net
    // of what is deployed. With exposure unreadable the whole cap is available
    // and someone already holding positions can size past their own limit.
    setMockBankroll(1000, 0, []); // cap of 1000, no wallet balance
    installApiMock();
    spies.push(
      spyOn(polyPortfolio, 'fetchPositions').mockImplementation(async () => {
        throw new Error('data api down');
      }),
    );

    const result = await kellySize({ edge: 0.15, marketProb: 0.5, market: makeMarket() });
    expect(result.openExposure).toBeNull();
    expect(result.sizingCaveat).toContain('risk.bankroll_usdc');

    restoreApiMock();
  });

  test('a readable exposure carries no caveat', async () => {
    setMockBankroll(1000, 0, [{ current_value: 200 }]);
    installApiMock();

    const result = await kellySize({ edge: 0.15, marketProb: 0.5, market: makeMarket() });
    expect(result.openExposure).toBe(200);
    expect(result.sizingCaveat).toBeUndefined();

    restoreApiMock();
  });
});

describe('Circuit Breaker', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  test('activates on drawdown breach', () => {
    insertRiskSnapshot(db, {
      timestamp: Math.floor(Date.now() / 1000),
      drawdown_current: 0.25,
      daily_pnl: -10,
    });

    const cb = new CircuitBreaker({ maxDrawdown: 0.20 });
    const status = cb.check(db);

    expect(status.active).toBe(true);
    expect(status.reason).toContain('Drawdown');
  });

  test('activates when daily loss exceeds limit', () => {
    insertRiskSnapshot(db, {
      timestamp: Math.floor(Date.now() / 1000),
      drawdown_current: 0.05,
      daily_pnl: -60, // -$60 USDC > -$50 limit
    });

    const cb = new CircuitBreaker({ dailyLossLimit: 50 });
    const status = cb.check(db);

    expect(status.active).toBe(true);
    expect(status.reason).toContain('Daily P&L');
  });

  test('inactive when within limits', () => {
    insertRiskSnapshot(db, {
      timestamp: Math.floor(Date.now() / 1000),
      drawdown_current: 0.05,
      daily_pnl: -10,
    });

    const cb = new CircuitBreaker();
    const status = cb.check(db);

    expect(status.active).toBe(false);
  });

  test('snapshot fetches live data and inserts', async () => {
    setMockBankroll(1000, 0, [{ current_value: 200 }]);
    // A snapshot is refused outright when the balance cannot be read, so this
    // has to supply one to reach the rest of the assertions.
    mockWalletCash = 1000;
    installApiMock();

    const cb = new CircuitBreaker();
    const snap = await cb.snapshot(db);

    expect(snap.cash_balance).toBe(1000);
    // Polymarket reports position value, not cash + payout
    expect(snap.portfolio_value).toBe(1000);
    expect(snap.open_exposure).toBe(200);
    expect(snap.available_bankroll).toBe(800);
    expect(snap.drawdown_current).toBeGreaterThanOrEqual(0);

    restoreApiMock();
  });
});

describe('Correlation', () => {
  let db: Database;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  test('counts positions per category correctly', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-2', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-3', category: 'weather', active: 1 });

    insertTestPosition(db, { position_id: 'p1', event_ticker: 'EV-1' });
    insertTestPosition(db, { position_id: 'p2', event_ticker: 'EV-2' });
    insertTestPosition(db, { position_id: 'p3', event_ticker: 'EV-3' });

    const counts = getCorrelationByCategory(db);

    expect(counts.get('politics')).toBe(2);
    expect(counts.get('weather')).toBe(1);
  });

  test('isCorrelated returns true when at limit', () => {
    upsertEvent(db, { ticker: 'EV-1', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-2', category: 'politics', active: 1 });
    upsertEvent(db, { ticker: 'EV-3', category: 'politics', active: 1 });

    insertTestPosition(db, { position_id: 'p1', event_ticker: 'EV-1' });
    insertTestPosition(db, { position_id: 'p2', event_ticker: 'EV-2' });
    insertTestPosition(db, { position_id: 'p3', event_ticker: 'EV-3' });

    expect(isCorrelated('EV-1', db, 3)).toBe(true);
    expect(isCorrelated('EV-1', db, 5)).toBe(false);
  });

  test('isCorrelated returns false for unknown event', () => {
    expect(isCorrelated('EV-UNKNOWN', db)).toBe(false);
  });
});
