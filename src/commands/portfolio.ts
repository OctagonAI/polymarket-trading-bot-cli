import type { ParsedArgs } from './parse-args.js';
import { formatBoxHeader } from './formatters.js';
import { theme } from '../theme.js';
import type { CLIResponse } from './json.js';
import { wrapSuccess } from './json.js';
import { getDb } from '../db/index.js';
import { getOpenPositions, getPositionWithEdge } from '../db/positions.js';
import type { PositionWithEdge } from '../db/positions.js';
import { fetchLiveBankroll } from '../risk/kelly.js';
import { fetchPositions, getWalletAddress } from '../tools/polymarket/portfolio.js';
import { getLatestSnapshot } from '../db/risk.js';
import type { RiskSnapshot } from '../db/risk.js';
import { formatTable } from './scan-formatters.js';
import { computePerformance } from '../eval/performance.js';
import type { PerformanceStats } from '../eval/performance.js';

export type { PerformanceStats };

export interface PositionView {
  ticker: string;
  direction: string;
  size: number;
  entryPrice: number;
  entryEdge: number | null;
  currentEdge: number | null;
  unrealizedPnl: number | null;
  watchdogStatus: string;
  /** True when this CLI opened the position and has edge history for it. */
  tracked: boolean;
}

export interface PortfolioData {
  positions: PositionView[];
  /**
   * True when the position list could not be read at all, as distinct from a
   * wallet that genuinely holds nothing.
   */
  positionsUnavailable: boolean;
  accountSummary: {
    cashBalance: number;
    /** Null when the Data API could not be read — unknown, not zero. */
    portfolioValue: number | null;
    openExposure: number | null;
    available: number;
    /** Null when the position list could not be read — unknown, not none. */
    positionsCount: number | null;
  } | null;
  riskSnapshot: RiskSnapshot | null;
  performance?: PerformanceStats;
}

function fmtMoney(v: number | null): string {
  return v === null ? 'unknown (could not read)' : `$${v.toFixed(2)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Share counts are fractional and can run to six decimals; two is plenty. */
function formatSize(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function deriveWatchdogStatus(pos: PositionWithEdge): string {
  if (!pos.latest_edge) return 'unknown';
  const entryEdge = pos.entry_edge ?? 0;
  const currentEdge = pos.latest_edge.edge;

  // Edge converging toward zero or flipped
  if (Math.sign(entryEdge) !== Math.sign(currentEdge) && entryEdge !== 0) return 'adverse_move';
  if (Math.abs(currentEdge) < Math.abs(entryEdge) * 0.5) return 'converging';
  return 'stable';
}

export async function handlePortfolio(args: ParsedArgs): Promise<CLIResponse<PortfolioData>> {
  const db = getDb();
  const warnings: string[] = [];

  // The wallet is the source of truth for what is held.
  //
  // The local `positions` table only ever contains positions this CLI opened
  // itself, so for an imported wallet it is empty or partial by construction —
  // using it as the list would under-report someone else's account as their own.
  // It is used solely to ENRICH the live rows with entry edge and watchdog
  // status, matched on ticker, which is information the Data API does not have.
  let positionViews: PositionView[] = [];
  let positionsCount: number | null = null;
  let positionsUnavailable = false;

  if (getWalletAddress()) {
    try {
      const live = await fetchPositions();

      // Index local tracking by ticker. Cheap, and tolerates the common case of
      // no local rows at all.
      const tracked = new Map<string, ReturnType<typeof getPositionWithEdge>>();
      try {
        for (const pos of getOpenPositions(db)) {
          tracked.set(pos.ticker, getPositionWithEdge(db, pos.position_id));
        }
      } catch (err) {
        warnings.push(`Local position tracking unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }

      positionViews = live.map((p) => {
        const ticker = p.ticker || p.token_id;
        const local = tracked.get(ticker);
        return {
          ticker,
          direction: p.outcome || '-',
          size: p.size,
          entryPrice: p.avg_price,
          entryEdge: local?.entry_edge ?? null,
          currentEdge: local?.latest_edge?.edge ?? null,
          // P&L comes from the venue, which knows about fills this CLI did not make.
          unrealizedPnl: p.cash_pnl ?? null,
          watchdogStatus: local ? deriveWatchdogStatus(local) : 'untracked',
          tracked: local !== undefined && local !== null,
        };
      });
      positionsCount = positionViews.length;
    } catch (err) {
      positionsUnavailable = true;
      warnings.push(`Positions unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Live bankroll — degrade gracefully on API failure (e.g. 503)
  let bankroll: Awaited<ReturnType<typeof fetchLiveBankroll>> | null = null;
  try {
    bankroll = await fetchLiveBankroll();
  } catch (err) {
    warnings.push(`Balance unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Risk snapshot
  let riskSnapshot: RiskSnapshot | null = null;
  try {
    riskSnapshot = getLatestSnapshot(db);
  } catch (err) {
    warnings.push(`Risk snapshot unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const data: PortfolioData = {
    positions: positionViews,
    positionsUnavailable,
    accountSummary: bankroll
      ? {
          cashBalance: bankroll.cashBalance,
          portfolioValue: bankroll.portfolioValue,
          openExposure: bankroll.openExposure,
          available: bankroll.availableBankroll,
          positionsCount,
        }
      : null,
    riskSnapshot,
  };

  // Performance stats if requested
  if (args.performance) {
    try {
      data.performance = computePerformance(db);
    } catch (err) {
      warnings.push(`Performance unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const meta: CLIResponse<PortfolioData>['meta'] = {
    ...(bankroll
      ? {
          bankroll: {
            cash_balance: bankroll.cashBalance,
            portfolio_value: bankroll.portfolioValue,
            open_exposure: bankroll.openExposure,
            available: bankroll.availableBankroll,
            positions_count: positionsCount,
          },
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  return wrapSuccess('portfolio', data, meta);
}

export function formatPortfolioHuman(data: PortfolioData, warnings: string[] = []): string {
  const lines: string[] = [];

  lines.push(...formatBoxHeader('PORTFOLIO'));
  lines.push('');

  // Positions table
  if (data.positions.length === 0) {
    lines.push('  No open positions.');
  } else {
    const rows = data.positions.map((p) => [
      // Market slugs run to 80+ characters and set the column width for the
      // whole table, so an untruncated one pushes every other column off-screen.
      truncate(p.ticker, 44),
      truncate(p.direction.toUpperCase(), 18),
      formatSize(p.size),
      `$${p.entryPrice.toFixed(2)}`,
      p.currentEdge !== null ? `${(p.currentEdge * 100).toFixed(1)}%` : '-',
      p.unrealizedPnl !== null ? `$${p.unrealizedPnl.toFixed(2)}` : '-',
      p.watchdogStatus,
    ]);
    lines.push(formatTable(
      ['Ticker', 'Dir', 'Size', 'Entry', 'Current Edge', 'P&L', 'Status'],
      rows
    ));
  }
  lines.push('');

  // Warnings first: they explain why the numbers below may be incomplete, and
  // reading them afterwards is too late.
  if (warnings.length > 0) {
    for (const w of warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }

  if (data.positions.some((p) => !p.tracked)) {
    lines.push(theme.muted('  Rows marked "untracked" were not opened through this CLI, so there is no'));
    lines.push(theme.muted('  entry edge to compare against. Size and P&L come from the venue.'));
    lines.push('');
  }

  // Account summary
  lines.push('  Account Summary:');
  if (data.accountSummary) {
    lines.push(`    Cash Balance:    $${data.accountSummary.cashBalance.toFixed(2)}`);
    // "unknown" rather than $0.00: a failed read is not an empty book, and
    // printing zero there is what made a 736-position wallet look empty.
    lines.push(`    Portfolio Value: ${fmtMoney(data.accountSummary.portfolioValue)}`);
    lines.push(`    Open Exposure:   ${fmtMoney(data.accountSummary.openExposure)}`);
    lines.push(`    Available:       $${data.accountSummary.available.toFixed(2)}`);
    lines.push(
      `    Positions:       ${data.accountSummary.positionsCount ?? 'unknown (could not read)'}`,
    );
  } else {
    lines.push('    (unavailable)');
  }
  lines.push('');

  // Risk snapshot
  if (data.riskSnapshot) {
    const snap = data.riskSnapshot;
    lines.push('  Risk Snapshot:');
    if (snap.drawdown_current != null) {
      lines.push(`    Current Drawdown: ${(snap.drawdown_current * 100).toFixed(1)}%`);
    }
    if (snap.drawdown_max != null) {
      lines.push(`    Max Drawdown:     ${(snap.drawdown_max * 100).toFixed(1)}%`);
    }
    if (snap.daily_pnl != null) {
      lines.push(`    Daily P&L:        $${snap.daily_pnl.toFixed(2)}`);
    }
    if (snap.circuit_breaker_on) {
      lines.push('    Circuit Breaker:  ACTIVE');
    }
    lines.push('');
  }

  // Performance stats
  if (data.performance) {
    const perf = data.performance;
    lines.push('  Performance:');
    if (perf.winRate !== null) {
      lines.push(`    Win Rate:    ${(perf.winRate * 100).toFixed(1)}%`);
    }
    lines.push(`    Total P&L:   $${perf.totalPnl.toFixed(2)}`);
    if (perf.sharpeRatio !== null) {
      lines.push(`    Sharpe Ratio: ${perf.sharpeRatio.toFixed(2)}`);
    }

    const brierEntries = Object.entries(perf.brierByCategory);
    if (brierEntries.length > 0) {
      lines.push('');
      lines.push('  Brier Scores by Category:');
      const brierRows = brierEntries.map(([cat, score]) => [cat, score.toFixed(3)]);
      lines.push(formatTable(['Category', 'Brier Score'], brierRows));
    }

    const pnlEntries = Object.entries(perf.pnlByCategory);
    if (pnlEntries.length > 0) {
      lines.push('');
      lines.push('  P&L by Category:');
      const pnlRows = pnlEntries.map(([cat, pnl]) => [cat, `$${pnl.toFixed(2)}`]);
      lines.push(formatTable(['Category', 'P&L'], pnlRows));
    }

    if (perf.underperformingCategories && perf.underperformingCategories.length > 0) {
      lines.push('');
      lines.push('  ⚠ Underperforming Categories (Brier > 0.30):');
      for (const cat of perf.underperformingCategories) {
        const score = perf.brierByCategory[cat];
        lines.push(`    - ${cat}: ${score !== undefined ? score.toFixed(3) : 'N/A'}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
