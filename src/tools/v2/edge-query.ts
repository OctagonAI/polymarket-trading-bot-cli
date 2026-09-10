import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getLatestEdge, getActionableEdges, getEdgesByExactConfidence, getEdgeHistory } from '../../db/edge.js';
import { formatToolResult } from '../types.js';

export const edgeQueryTool = new DynamicStructuredTool({
  name: 'edge_query',
  description: 'Query edge signals and mispricing data from the local scan database.',
  schema: z.object({
    ticker: z.string().optional().describe('Specific market ticker to query'),
    theme: z.string().optional().describe('Theme ID to filter by'),
    minConfidence: z.enum(['low', 'moderate', 'high', 'very_high']).optional().describe('Minimum confidence level (returns this level and above). Use exactConfidence instead if user wants only one level.'),
    exactConfidence: z.enum(['low', 'moderate', 'high', 'very_high']).optional().describe('Exact confidence level (returns only this level, not above). Use when user says "moderate edges" or "only high confidence".'),
    excludeKeywords: z.array(z.string()).optional().describe('Exclude edges whose ticker or event title contains any of these keywords (case-insensitive). Use for "skip trump", "exclude crypto", etc.'),
  }),
  func: async ({ ticker, theme, minConfidence, exactConfidence, excludeKeywords }) => {
    const db = getDb();

    if (ticker) {
      const latest = getLatestEdge(db, ticker);
      if (!latest) return formatToolResult({ message: `No edge data found for ${ticker}` });

      const history = getEdgeHistory(db, ticker, 0).slice(-10); // last 10 entries
      return formatToolResult({
        latest: {
          ...latest,
          drivers: latest.drivers_json ? JSON.parse(latest.drivers_json) : [],
          sources: latest.sources_json ? JSON.parse(latest.sources_json) : [],
          catalysts: latest.catalysts_json ? JSON.parse(latest.catalysts_json) : [],
        },
        recentHistory: history.map((h) => ({
          timestamp: h.timestamp,
          edge: h.edge,
          modelProb: h.model_prob,
          marketProb: h.market_prob,
          confidence: h.confidence,
        })),
      });
    }

    if (theme) {
      const themeRows = db.query(
        `SELECT DISTINCT ticker FROM edge_history
         WHERE event_ticker IN (SELECT event_ticker FROM events WHERE theme_id = $theme)`
      ).all({ $theme: theme }) as { ticker: string }[];

      let edges = themeRows
        .map((t) => getLatestEdge(db, t.ticker))
        .filter((r) => r !== null)
        .sort((a, b) => Math.abs(b!.edge) - Math.abs(a!.edge));

      if (excludeKeywords?.length) {
        edges = applyKeywordExclusion(db, edges, excludeKeywords);
      }

      return formatToolResult({ theme, edges, count: edges.length });
    }

    // Default: actionable edges
    let edges = exactConfidence
      ? getEdgesByExactConfidence(db, exactConfidence)
      : getActionableEdges(db, minConfidence ?? 'moderate');
    edges.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

    if (excludeKeywords?.length) {
      edges = applyKeywordExclusion(db, edges, excludeKeywords);
    }

    const confidenceFilter = exactConfidence
      ? { exactConfidence }
      : { minConfidence: minConfidence ?? 'moderate' };

    return formatToolResult({
      edges: edges.slice(0, 20).map((e) => ({
        ticker: e.ticker,
        edge: e.edge,
        edgePct: `${(e.edge * 100).toFixed(1)}%`,
        modelProb: e.model_prob,
        marketProb: e.market_prob,
        confidence: e.confidence,
        timestamp: e.timestamp,
      })),
      count: edges.length,
      filter: confidenceFilter,
    });
  },
});

/** Filter out edges whose ticker or event title matches any excluded keyword. */
function applyKeywordExclusion<T extends { ticker: string; event_ticker: string }>(
  db: ReturnType<typeof getDb>,
  edges: T[],
  keywords: string[],
): T[] {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  // Build a title lookup from event_index for all relevant event tickers
  const eventTickers = [...new Set(edges.map((e) => e.event_ticker))];
  const titleMap = new Map<string, string>();
  if (eventTickers.length > 0) {
    const placeholders = eventTickers.map(() => '?').join(', ');
    const rows = db.query(
      `SELECT event_ticker, title FROM event_index WHERE event_ticker IN (${placeholders})`
    ).all(...eventTickers) as { event_ticker: string; title: string }[];
    for (const row of rows) {
      titleMap.set(row.event_ticker, row.title.toLowerCase());
    }
  }

  return edges.filter((e) => {
    const tickerLower = e.ticker.toLowerCase();
    const titleLower = titleMap.get(e.event_ticker) ?? '';
    return !lowerKeywords.some((kw) => tickerLower.includes(kw) || titleLower.includes(kw));
  });
}

export const EDGE_QUERY_DESCRIPTION = `
Query edge signals and mispricing data from the local scan database.

## When to Use
- User asks about current edges, mispricings, or opportunities
- "What's the edge on crypto?" or "Show me high-confidence edges"
- Checking if a specific market has an actionable edge signal
- Filtering edges: "show moderate edges", "skip trump", "exclude crypto"

## When NOT to Use
- For live market data from Polymarket (use polymarket_search)
- For placing trades (use polymarket_trade)

## Parameters
- **minConfidence**: Returns edges at this level AND above. "high" → high + very_high.
- **exactConfidence**: Returns edges at ONLY this level. "moderate" → moderate only, not high/very_high. Prefer this when the user asks for a specific level like "show moderate edges".
- **excludeKeywords**: Filters out edges whose ticker or event title contains any keyword. Use for "skip trump", "but not crypto", etc.
`.trim();
