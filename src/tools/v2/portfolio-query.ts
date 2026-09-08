import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getOpenPositions, getPositionWithEdge } from '../../db/positions.js';
import { fetchLiveBankroll } from '../../risk/kelly.js';
import { getLatestSnapshot } from '../../db/risk.js';
import { computePerformance } from '../../eval/performance.js';
import { formatToolResult } from '../types.js';

export const portfolioQueryTool = new DynamicStructuredTool({
  name: 'portfolio_query',
  description: 'Get positions with current edge data, P&L, bankroll summary, and optional performance stats.',
  schema: z.object({
    includePerformance: z.boolean().optional().describe('Include historical performance stats (win rate, Sharpe, Brier scores)'),
  }),
  func: async ({ includePerformance }) => {
    const db = getDb();

    const openPositions = getOpenPositions(db);
    const positions = openPositions.map((pos) => {
      const withEdge = getPositionWithEdge(db, pos.position_id);
      return {
        ticker: pos.ticker,
        direction: pos.direction,
        size: pos.size,
        entryPrice: pos.entry_price,
        entryEdge: pos.entry_edge ?? null,
        currentEdge: withEdge?.latest_edge?.edge ?? null,
        unrealizedPnl: pos.current_pnl ?? null,
        status: pos.status,
      };
    });

    let bankroll;
    try {
      bankroll = await fetchLiveBankroll();
    } catch {
      bankroll = null;
    }

    const riskSnapshot = getLatestSnapshot(db);

    const result: Record<string, unknown> = {
      positions,
      positionsCount: positions.length,
      bankroll: bankroll ? {
        cashBalance: bankroll.cashBalance,
        portfolioValue: bankroll.portfolioValue,
        openExposure: bankroll.openExposure,
        available: bankroll.availableBankroll,
      } : null,
      riskSnapshot: riskSnapshot ? {
        drawdownCurrent: riskSnapshot.drawdown_current,
        drawdownMax: riskSnapshot.drawdown_max,
        dailyPnl: riskSnapshot.daily_pnl,
        circuitBreakerOn: !!riskSnapshot.circuit_breaker_on,
      } : null,
    };

    if (includePerformance) {
      result.performance = computePerformance(db);
    }

    return formatToolResult(result);
  },
});

export const PORTFOLIO_QUERY_DESCRIPTION = `
Get positions with current edge data, P&L, bankroll summary, and optional performance stats.

## When to Use
- User asks about their positions with edge context ("how are my positions doing?")
- Needs bankroll + positions + risk in one call
- Wants performance stats (win rate, Sharpe, Brier)

## When NOT to Use
- Quick balance check only (use portfolio_overview)
- Detailed order history or fills (use polymarket_search)
`.trim();
