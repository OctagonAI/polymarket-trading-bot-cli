import type { Database } from 'bun:sqlite';
import { fetchLiveBankroll } from './kelly.js';
import { loadWalletIdentity } from '../wallet/identity.js';
import {
  insertRiskSnapshot,
  getLatestSnapshot,
  getEquityHistory,
  getLatestSnapshotWithEquity,
} from '../db/risk.js';
import type { RiskSnapshot } from '../db/risk.js';

/**
 * Raised when a snapshot cannot be computed, so that none is written.
 *
 * Distinct from a generic failure because the caller's correct response is to
 * retry later rather than to treat the account as safe.
 */
export class RiskSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskSnapshotError';
  }
}

export interface CircuitBreakerConfig {
  dailyLossLimit?: number;  // USDC, default 50
  maxDrawdown?: number;     // fraction, default 0.20
}

/**
 * How old a risk reading may be before it stops meaning anything.
 *
 * Refusing to write a snapshot keeps the history honest but says nothing about
 * the read: `check()` takes the newest row whatever its age, so a gated RPC
 * leaves `buy` quoting a breaker state from before the outage. Six hours is
 * loose enough not to nag anyone scanning hourly, and tight enough to catch a
 * scanner that died overnight.
 */
export const SNAPSHOT_STALE_AFTER_SECONDS = 6 * 60 * 60;

export interface CircuitBreakerStatus {
  active: boolean;
  reason?: string;
  /**
   * Age of the snapshot this verdict came from, when it is past
   * `SNAPSHOT_STALE_AFTER_SECONDS`. Absent when the reading is current.
   */
  staleSeconds?: number;
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
  check(db: Database, now: number = Math.floor(Date.now() / 1000)): CircuitBreakerStatus {
    const snapshot = getLatestSnapshot(db);
    if (!snapshot) return { active: false };

    // Reported, never acted on. A stale reading is not evidence of a loss, and
    // treating it as one would refuse orders to everyone who does not run the
    // scanner at all — which is most people, since they have no snapshots.
    const ageSeconds = Math.max(0, now - snapshot.timestamp);
    const stale = ageSeconds > SNAPSHOT_STALE_AFTER_SECONDS ? { staleSeconds: ageSeconds } : {};

    // Check daily P&L loss limit
    if (snapshot.daily_pnl != null && snapshot.daily_pnl < -this.config.dailyLossLimit) {
      return {
        active: true,
        reason: `Daily P&L $${snapshot.daily_pnl.toFixed(2)} exceeds loss limit of -$${this.config.dailyLossLimit.toFixed(2)}`,
        ...stale,
      };
    }

    // Check drawdown
    if (snapshot.drawdown_current != null && snapshot.drawdown_current >= this.config.maxDrawdown) {
      return {
        active: true,
        reason: `Drawdown ${(snapshot.drawdown_current * 100).toFixed(1)}% >= max ${this.config.maxDrawdown * 100}%`,
        ...stale,
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
   * When equity cannot be read, this throws rather than writing a row. It used
   * to write one with `drawdown_current` and `daily_pnl` left at their
   * initialised zeros, and `check()` reads the newest row — so a single failed
   * balance read cleared a breaker that a real reading had tripped, and trading
   * resumed on an account still in drawdown.
   *
   * Refusing to record what could not be computed keeps the table honest and
   * leaves `check()` reading the last real measurement. The caller retries on
   * its next pass; a sustained outage keeps failing loudly instead of quietly
   * reporting safety.
   *
   * @throws {@link RiskSnapshotError} when the balance could not be read.
   */
  async snapshot(db: Database): Promise<RiskSnapshot> {
    const bankroll = await fetchLiveBankroll();

    // Only a *failed read* is a refusal. With no wallet there is no equity to
    // know, no position to lose and no breaker to protect — research-only users
    // run `scan` and `watch` all day, and throwing at them would break the
    // thing the fix was meant to keep safe.
    const hasWallet = loadWalletIdentity().tier !== 'none';
    if (hasWallet && bankroll.equity === null) {
      throw new RiskSnapshotError(
        'Could not read the wallet balance, so equity is unknown and no risk snapshot was taken. ' +
          'The previous snapshot still stands; retry when the balance is readable.',
      );
    }

    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    // Only rows carrying a real equity reading: pre-migration rows and rows
    // taken while the balance was unreadable would otherwise enter the walk as
    // an account worth nothing.
    const history = getEquityHistory(db, dayAgo);

    const equity = bankroll.equity;
    let drawdownCurrent = 0;
    let dailyPnl = 0;

    // Reachable only with no wallet, where equity is unknowable rather than
    // unread; with one, the refusal above has already returned.
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
