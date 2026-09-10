import type { Database } from 'bun:sqlite';
import { fetchLiveBankroll } from './kelly.js';
import { insertRiskSnapshot, getLatestSnapshot, getDrawdownHistory } from '../db/risk.js';
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
   * Take a fresh snapshot: fetch live bankroll, compute drawdown vs
   * portfolio high-water mark from risk_snapshots history, insert new snapshot.
   */
  async snapshot(db: Database): Promise<RiskSnapshot> {
    const bankroll = await fetchLiveBankroll();

    // Compute high-water mark from history
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const history = getDrawdownHistory(db, dayAgo);

    let highWaterMark = bankroll.portfolioValue;
    let dailyPnl = 0;

    if (history.length > 0) {
      // High-water mark is max portfolio_value across all snapshots
      for (const h of history) {
        if (h.portfolio_value != null && h.portfolio_value > highWaterMark) {
          highWaterMark = h.portfolio_value;
        }
      }

      // Daily P&L = current portfolio value - earliest snapshot's portfolio value in the window
      const earliest = history[0];
      if (earliest.portfolio_value != null) {
        dailyPnl = bankroll.portfolioValue - earliest.portfolio_value;
      }
    }

    // Drawdown = (high_water - current) / high_water
    const drawdownCurrent = highWaterMark > 0
      ? (highWaterMark - bankroll.portfolioValue) / highWaterMark
      : 0;

    // Max drawdown is the worst we've seen
    const latestSnapshot = getLatestSnapshot(db);
    const drawdownMax = Math.max(
      drawdownCurrent,
      latestSnapshot?.drawdown_max ?? 0
    );

    const now = Math.floor(Date.now() / 1000);
    const cbStatus = this.check(db);

    const snapshot: RiskSnapshot = {
      timestamp: now,
      cash_balance: bankroll.cashBalance,
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
