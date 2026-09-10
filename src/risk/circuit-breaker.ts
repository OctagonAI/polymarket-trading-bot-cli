import type { Database } from 'bun:sqlite';
import { fetchLiveBankroll } from './kelly.js';
import {
  insertRiskSnapshot,
  getLatestSnapshot,
  getEquityHistory,
  getLatestSnapshotWithEquity,
} from '../db/risk.js';
import type { RiskSnapshot } from '../db/risk.js';

export interface CircuitBreakerConfig {
  dailyLossLimit?: number;  // USDC, default 50
  maxDrawdown?: number;     // fraction, default 0.20
}

export interface CircuitBreakerStatus {
  active: boolean;
  reason?: string;
}

export class CircuitBreaker {
  private config: Required<CircuitBreakerConfig>;

  constructor(config?: CircuitBreakerConfig) {
    this.config = {
      dailyLossLimit: config?.dailyLossLimit ?? 50,
      maxDrawdown: config?.maxDrawdown ?? 0.20,
    };
  }

  /**
   * Check if circuit breaker should be active.
   * Reads latest risk snapshot — does not call external APIs.
   */
  check(db: Database): CircuitBreakerStatus {
    const snapshot = getLatestSnapshot(db);
    if (!snapshot) return { active: false };

    // Check daily P&L loss limit
    if (snapshot.daily_pnl != null && snapshot.daily_pnl < -this.config.dailyLossLimit) {
      return {
        active: true,
        reason: `Daily P&L $${snapshot.daily_pnl.toFixed(2)} exceeds loss limit of -$${this.config.dailyLossLimit.toFixed(2)}`,
      };
    }

    // Check drawdown
    if (snapshot.drawdown_current != null && snapshot.drawdown_current >= this.config.maxDrawdown) {
      return {
        active: true,
        reason: `Drawdown ${(snapshot.drawdown_current * 100).toFixed(1)}% >= max ${this.config.maxDrawdown * 100}%`,
      };
    }

    return { active: false };
  }

  /**
   * Take a fresh snapshot: fetch live bankroll, compute drawdown against the
   * 24h equity high-water mark, insert a new snapshot.
   *
   * Drawdown is measured on **equity** (`wallet_cash + portfolio_value`), not on
   * position value alone. Selling a position converts mark-to-market value into
   * cash, so a portfolio-value-only measure read that as a loss all the way to
   * ~100% while the capital was untouched — and because the running maximum
   * only ever ratchets up, one such reading permanently failed the drawdown gate
   * on every later `analyze`.
   *
   * When equity is unknown, drawdown is reported as 0 and the snapshot records a
   * null equity rather than a zero. A missing reading is not a loss, and writing
   * a zero here is exactly what would recreate the bug above.
   */
  async snapshot(db: Database): Promise<RiskSnapshot> {
    const bankroll = await fetchLiveBankroll();

    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    // Only rows carrying a real equity reading: pre-migration rows and rows
    // taken while the balance was unreadable would otherwise enter the walk as
    // an account worth nothing.
    const history = getEquityHistory(db, dayAgo);

    const equity = bankroll.equity;
    let drawdownCurrent = 0;
    let dailyPnl = 0;

    if (equity !== null) {
      let highWaterMark = equity;
      for (const h of history) {
        if (h.equity != null && h.equity > highWaterMark) highWaterMark = h.equity;
      }

      drawdownCurrent = highWaterMark > 0
        ? Math.max(0, (highWaterMark - equity) / highWaterMark)
        : 0;

      const earliest = history[0];
      if (earliest?.equity != null) dailyPnl = equity - earliest.equity;
    }

    // Carry the running maximum forward from the last snapshot that had a real
    // reading, so a gap of unreadable snapshots neither resets it nor lets
    // pre-equity history seed it.
    const previous = getLatestSnapshotWithEquity(db);
    const drawdownMax = Math.max(drawdownCurrent, previous?.drawdown_max ?? 0);

    const now = Math.floor(Date.now() / 1000);
    const cbStatus = this.check(db);

    const snapshot: RiskSnapshot = {
      timestamp: now,
      cash_balance: bankroll.cashBalance,
      wallet_cash: bankroll.walletCash,
      equity,
      portfolio_value: bankroll.portfolioValue,
      open_exposure: bankroll.openExposure,
      available_bankroll: bankroll.availableBankroll,
      daily_pnl: dailyPnl,
      drawdown_current: drawdownCurrent,
      drawdown_max: drawdownMax,
      positions_count: null, // caller can set if needed
      circuit_breaker_on: cbStatus.active ? 1 : 0,
    };

    insertRiskSnapshot(db, snapshot);
    return snapshot;
  }
}
