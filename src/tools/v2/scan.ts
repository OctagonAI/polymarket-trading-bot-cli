import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { auditTrail } from '../../audit/index.js';
import { ScanLoop } from '../../scan/loop.js';
import { createOctagonInvoker } from '../../scan/invoker.js';
import { formatToolResult } from '../types.js';

export const scanTool = new DynamicStructuredTool({
  name: 'scan_markets',
  description: 'Run a live market scan: fetches events from Polymarket, calls Octagon for model probabilities, computes edges, and stores results in the local database.',
  schema: z.object({
    theme: z.string().optional().describe('Theme to scan: "top50" (default), or any category — "politics", "elections", "economics", "finance", "crypto", "commodities", "sports", "culture", "tech-science", "climate", "mentions", or a custom theme ID'),
  }),
  func: async ({ theme }) => {
    const db = getDb();
    const invoker = createOctagonInvoker();
    const loop = new ScanLoop(db, auditTrail, invoker);

    const result = await loop.runOnce({
      theme: theme ?? 'top50',
    });

    const actionable = result.edgeSnapshots.filter(
      (s) => s.confidence === 'high' || s.confidence === 'very_high'
    );

    // Return a compact summary with the most interesting edges
    const edges = result.edgeSnapshots
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .slice(0, 30)
      .map((s) => ({
        ticker: s.ticker,
        eventTicker: s.eventTicker,
        modelProb: s.modelProb,
        marketProb: s.marketProb,
        edge: s.edge,
        edgePct: `${(s.edge * 100).toFixed(1)}%`,
        confidence: s.confidence,
        drivers: s.drivers.slice(0, 2),
      }));

    return formatToolResult({
      scanId: result.scanId,
      theme: theme ?? 'top50',
      eventsScanned: result.eventsScanned,
      totalEdges: result.edgeSnapshots.length,
      actionableCount: actionable.length,
      octagonCreditsUsed: result.octagonCreditsUsed,
      durationMs: result.duration,
      topEdges: edges,
      alerts: result.alerts.map((a) => ({ alertType: a.alertType, message: a.message })),
    });
  },
});

export const SCAN_DESCRIPTION = `
Run a live market scan. Fetches events from Polymarket, calls Octagon AI for model probabilities, computes pricing edges (model vs market), and stores all results in the local database.

## When to Use
- User says "scan", "scan crypto", "scan politics", "find edges", "run a scan"
- User wants to discover mispriced markets across a category
- User wants to populate/refresh the edge database before querying it

## When NOT to Use
- For querying existing edge data already in the database (use edge_query instead — it's instant)
- For looking up a specific market's price or details (use polymarket_search)

## Themes
- "top50" (default): Top 50 markets by 24h volume
- "politics", "elections", "economics", "finance", "crypto", "commodities", "sports", "culture", "tech-science", "climate", "mentions": Category-based scans
- Custom theme ID: Pre-configured in database

## Notes
- Scans can take 30-120 seconds depending on the number of events
- Each fresh Octagon call costs 3 credits (cached calls are free)
- Results are stored in edge_history and can be queried later with edge_query
`.trim();
