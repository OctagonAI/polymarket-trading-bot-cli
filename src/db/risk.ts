import type { Database } from 'bun:sqlite';

export interface RiskSnapshot {
  id?: number;
  timestamp: number;
  cash_balance?: number | null;
  /**
   * Free collateral read from the chain, or null when it could not be read.
   *
   * NEVER coerce a failed read to 0 — see `equity`.
   */
  wallet_cash?: number | null;
  /**
   * `wallet_cash + portfolio_value`, or null when `wallet_cash` is null.
   *
   * Drawdown is computed against this rather than `portfolio_value`, because
   * closing a position just moves value from one term to the other and so
   * leaves equity unchanged. Rows with a null equity are excluded from every
   * high-water-mark walk, which is what keeps pre-migration rows and transient
   * RPC failures from being read as a collapse to zero.
   */
  equity?: number | null;
  portfolio_value?: number | null;
  open_exposure?: number | null;
  available_bankroll?: number | null;
  daily_pnl?: number | null;
  drawdown_current?: number | null;
  drawdown_max?: number | null;
  correlation_max?: number | null;
  positions_count?: number | null;
  circuit_breaker_on?: number | null;
}

export function insertRiskSnapshot(db: Database, snapshot: RiskSnapshot): void {
  db.prepare(`
    INSERT INTO risk_snapshots
      (timestamp, cash_balance, wallet_cash, equity, portfolio_value, open_exposure, available_bankroll,
       daily_pnl, drawdown_current, drawdown_max, correlation_max, positions_count, circuit_breaker_on)
    VALUES
      ($timestamp, $cash_balance, $wallet_cash, $equity, $portfolio_value, $open_exposure, $available_bankroll,
       $daily_pnl, $drawdown_current, $drawdown_max, $correlation_max, $positions_count, $circuit_breaker_on)
  `).run({
    $timestamp: snapshot.timestamp,
    $cash_balance: snapshot.cash_balance ?? null,
    $wallet_cash: snapshot.wallet_cash ?? null,
    $equity: snapshot.equity ?? null,
    $portfolio_value: snapshot.portfolio_value ?? null,
    $open_exposure: snapshot.open_exposure ?? null,
    $available_bankroll: snapshot.available_bankroll ?? null,
    $daily_pnl: snapshot.daily_pnl ?? null,
    $drawdown_current: snapshot.drawdown_current ?? null,
    $drawdown_max: snapshot.drawdown_max ?? null,
    $correlation_max: snapshot.correlation_max ?? null,
    $positions_count: snapshot.positions_count ?? null,
    $circuit_breaker_on: snapshot.circuit_breaker_on ?? 0,
  });
}

/**
 * Every ordering here tie-breaks on `id`. `timestamp` is whole seconds, so two
 * snapshots taken in the same second compare equal and "latest" would otherwise
 * be whichever row SQLite happened to return — which silently loses the newer
 * `drawdown_max` when a scan pass snapshots twice in a second.
 */
export function getLatestSnapshot(db: Database): RiskSnapshot | null {
  return db.query(
    'SELECT * FROM risk_snapshots ORDER BY timestamp DESC, id DESC LIMIT 1'
  ).get() as RiskSnapshot | null;
}

export function getDrawdownHistory(db: Database, since: number): RiskSnapshot[] {
  return db.query(
    'SELECT * FROM risk_snapshots WHERE timestamp >= $since ORDER BY timestamp ASC, id ASC'
  ).all({ $since: since }) as RiskSnapshot[];
}

/**
 * Snapshots in the window that carry a usable equity reading, oldest first.
 *
 * Prefer this over `getDrawdownHistory` for anything that compares account
 * value over time. Rows written before the equity columns existed, and rows
 * taken while the balance was unreadable, both have `equity IS NULL` — feeding
 * them to a high-water-mark walk would read as a collapse to zero.
 */
export function getEquityHistory(db: Database, since: number): RiskSnapshot[] {
  return db.query(
    'SELECT * FROM risk_snapshots WHERE equity IS NOT NULL AND timestamp >= $since ORDER BY timestamp ASC, id ASC'
  ).all({ $since: since }) as RiskSnapshot[];
}

/**
 * Most recent snapshot that had a usable equity reading, or null.
 *
 * `drawdown_max` is carried forward from here rather than from
 * `getLatestSnapshot`, so a run of unreadable-balance snapshots does not reset
 * the running maximum and pre-equity history does not seed it.
 */
export function getLatestSnapshotWithEquity(db: Database): RiskSnapshot | null {
  return db.query(
    'SELECT * FROM risk_snapshots WHERE equity IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1'
  ).get() as RiskSnapshot | null;
}
