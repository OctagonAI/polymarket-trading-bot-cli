import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createDb } from '../../db/index.js';
import {
  insertRiskSnapshot,
  getEquityHistory,
  getLatestSnapshotWithEquity,
} from '../../db/risk.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import * as kelly from '../kelly.js';
import type { LiveBankroll } from '../kelly.js';

/**
 * Drawdown is measured on equity (cash + position value) rather than on
 * position value alone.
 *
 * The bug these tests pin: selling a position moved value out of
 * `portfolio_value` and into cash the old formula could not see, so a clean
 * exit read as a ~100% drawdown. `drawdown_max` only ratchets upward, so one
 * such reading permanently failed the drawdown gate on every later `analyze`.
 */

const spies: Array<{ mockRestore: () => void }> = [];

/** A LiveBankroll with only the fields the snapshot maths reads. */
function bankroll(walletCash: number | null, portfolioValue: number): LiveBankroll {
  return {
    cashBalance: walletCash ?? 0,
    portfolioValue,
    openExposure: 0,
    availableBankroll: walletCash ?? 0,
    bankrollUnset: walletCash === null,
    bankrollSource: walletCash === null ? 'none' : 'wallet',
    cap: null,
    positionsUnavailable: false,
    portfolioValueUnavailable: false,
    walletCash,
    equity: walletCash === null ? null : walletCash + portfolioValue,
  };
}

function stubBankroll(b: LiveBankroll) {
  spies.push(spyOn(kelly, 'fetchLiveBankroll').mockImplementation(async () => b));
}

describe('equity-based drawdown', () => {
  let db: Database;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    db = createDb(':memory:');
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  test('closing a position into cash is not a drawdown', async () => {
    // $1,000 fully deployed, then fully realised. Capital never changed, so
    // drawdown must stay at 0 — the old formula reported 100% here.
    stubBankroll(bankroll(0, 1000));
    await breaker.snapshot(db);

    stubBankroll(bankroll(1000, 0));
    const after = await breaker.snapshot(db);

    expect(after.equity).toBe(1000);
    expect(after.drawdown_current).toBe(0);
    expect(after.drawdown_max).toBe(0);
  });

  test('a real loss still registers', async () => {
    stubBankroll(bankroll(0, 1000));
    await breaker.snapshot(db);

    stubBankroll(bankroll(0, 800));
    const after = await breaker.snapshot(db);

    expect(after.equity).toBe(800);
    expect(after.drawdown_current).toBeCloseTo(0.2, 10);
  });

  test('a deposit raises the high-water mark rather than showing as profit-then-loss', async () => {
    stubBankroll(bankroll(500, 0));
    await breaker.snapshot(db);

    stubBankroll(bankroll(1500, 0)); // deposited $1,000
    const after = await breaker.snapshot(db);

    expect(after.drawdown_current).toBe(0);
    expect(after.equity).toBe(1500);
  });

  test('an unreadable balance records null equity and no drawdown', async () => {
    stubBankroll(bankroll(1000, 0));
    await breaker.snapshot(db);

    // RPC failed. This must not read as "equity fell to zero" — writing a 0
    // here is precisely what the old code did with portfolio_value.
    stubBankroll(bankroll(null, 0));
    const after = await breaker.snapshot(db);

    expect(after.equity).toBeNull();
    expect(after.wallet_cash).toBeNull();
    expect(after.drawdown_current).toBe(0);
  });

  test('rows without equity are excluded from the high-water mark', async () => {
    // A pre-migration row: large portfolio_value, no equity reading. If it
    // entered the walk it would set a $9,000 high-water mark and make the
    // snapshot below look like a 94% drawdown.
    insertRiskSnapshot(db, {
      timestamp: Math.floor(Date.now() / 1000) - 600,
      portfolio_value: 9000,
      equity: null,
      wallet_cash: null,
    });

    stubBankroll(bankroll(500, 0));
    const after = await breaker.snapshot(db);

    expect(after.drawdown_current).toBe(0);
  });

  test('drawdown_max carries forward across an unreadable snapshot', async () => {
    stubBankroll(bankroll(1000, 0));
    await breaker.snapshot(db);

    stubBankroll(bankroll(700, 0)); // 30% down
    const drop = await breaker.snapshot(db);
    expect(drop.drawdown_max).toBeCloseTo(0.3, 10);

    stubBankroll(bankroll(null, 0)); // balance unreadable
    const blind = await breaker.snapshot(db);
    expect(blind.drawdown_max).toBeCloseTo(0.3, 10);
  });

  test('daily P&L is the equity delta, in USDC', async () => {
    stubBankroll(bankroll(1000, 0));
    await breaker.snapshot(db);

    stubBankroll(bankroll(940, 0));
    const after = await breaker.snapshot(db);

    expect(after.daily_pnl).toBeCloseTo(-60, 10);
  });
});

describe('equity history queries', () => {
  let db: Database;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    db = createDb(':memory:');
    insertRiskSnapshot(db, { timestamp: now - 300, portfolio_value: 9000, equity: null });
    insertRiskSnapshot(db, { timestamp: now - 200, portfolio_value: 100, equity: 800 });
    insertRiskSnapshot(db, { timestamp: now - 100, portfolio_value: 100, equity: null });
  });

  test('getEquityHistory skips rows with no reading', () => {
    const rows = getEquityHistory(db, now - 86400);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.equity).toBe(800);
  });

  test('getLatestSnapshotWithEquity skips the newer unreadable row', () => {
    expect(getLatestSnapshotWithEquity(db)?.equity).toBe(800);
  });
});
