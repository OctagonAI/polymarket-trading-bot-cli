import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getOpenPositions } from '../../db/positions.js';
import { getLatestSnapshot } from '../../db/risk.js';
import { formatToolResult } from '../types.js';
import { getBotSetting } from '../../utils/bot-config.js';

export const riskStatusTool = new DynamicStructuredTool({
  name: 'risk_status',
  description: 'Check risk gate status: circuit breaker, drawdown, correlation, concentration limits.',
  schema: z.object({}),
  func: async () => {
    const db = getDb();

    const snapshot = getLatestSnapshot(db);
    const openPositions = getOpenPositions(db);

    // Read the same settings gate.ts enforces. Hardcoding them meant this tool
    // could report "within limits" against a limit the gate was not using.
    const maxDrawdownPct = Number(getBotSetting('risk.max_drawdown'));
    const maxTotalPositions = Number(getBotSetting('risk.max_positions'));

    const checks = [];

    // Circuit breaker
    const circuitBreakerOn = !!snapshot?.circuit_breaker_on;
    checks.push({
      name: 'circuit_breaker',
      status: circuitBreakerOn ? 'TRIGGERED' : 'OK',
      detail: circuitBreakerOn ? 'Circuit breaker is active — no new trades allowed' : 'Circuit breaker inactive',
    });

    // Drawdown
    const drawdown = snapshot?.drawdown_current ?? 0;
    const drawdownOk = drawdown < maxDrawdownPct;
    checks.push({
      name: 'drawdown',
      status: drawdownOk ? 'OK' : 'EXCEEDED',
      detail: `Current: ${(drawdown * 100).toFixed(1)}% / Max allowed: ${maxDrawdownPct * 100}%`,
      current: drawdown,
      limit: maxDrawdownPct,
    });

    // Concentration
    const posCount = openPositions.length;
    const concentrationOk = posCount < maxTotalPositions;
    checks.push({
      name: 'concentration',
      status: concentrationOk ? 'OK' : 'EXCEEDED',
      detail: `${posCount} open positions / Max: ${maxTotalPositions}`,
      current: posCount,
      limit: maxTotalPositions,
    });

    // Max drawdown
    checks.push({
      name: 'max_drawdown',
      status: 'INFO',
      detail: snapshot?.drawdown_max != null
        ? `Peak drawdown: ${(snapshot.drawdown_max * 100).toFixed(1)}%`
        : 'No drawdown history yet',
      current: snapshot?.drawdown_max ?? null,
    });

    // Daily P&L
    checks.push({
      name: 'daily_pnl',
      status: 'INFO',
      // Already USDC — CircuitBreaker.snapshot writes it as a dollar amount.
      // The /100 here was a Kalshi-cents carryover that under-reported by 100x.
      detail: snapshot?.daily_pnl != null
        ? `Daily P&L: $${snapshot.daily_pnl.toFixed(2)}`
        : 'No daily P&L data',
      current: snapshot?.daily_pnl ?? null,
    });

    const allPassed = !circuitBreakerOn && drawdownOk && concentrationOk;

    return formatToolResult({
      overallStatus: allPassed ? 'CLEAR' : 'BLOCKED',
      checks,
      snapshotTimestamp: snapshot?.timestamp ?? null,
    });
  },
});

export const RISK_STATUS_DESCRIPTION = `
Check the current risk gate status including circuit breaker, drawdown, and concentration limits.

## When to Use
- User asks "can I trade?" or "what's the risk status?"
- Before recommending trades, to check if risk gates allow it
- Checking if circuit breaker has been triggered

## When NOT to Use
- For portfolio positions or P&L (use portfolio_query)
- For specific market risk analysis
`.trim();
