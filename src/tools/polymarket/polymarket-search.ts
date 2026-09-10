import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { octagonReportTool } from '../v2/octagon-report.js';
import { logger } from '../../utils/logger.js';

// All read-only Polymarket tools available for routing
import { getMarkets, getMarket, getMarketOrderbook, getMarketPriceHistory } from './markets.js';
import { getEvents, getEvent, searchEventsTool } from './events.js';
import { getSeries } from './series.js';
import { getBalance, getPositions, getWalletAddress } from './portfolio.js';
import { getExchangeStatus } from './exchange.js';

export const POLYMARKET_SEARCH_DESCRIPTION = `
Intelligent meta-tool for Polymarket prediction market research. Takes a natural language query and automatically routes to appropriate Polymarket data sources.

## When to Use

- Finding markets by topic, category, or keyword
- Getting market prices (bid/ask per outcome), volume, liquidity, and close dates
- Fetching event details and every market inside them
- Checking wallet positions and portfolio value (only when a wallet is configured)
- Getting live CLOB order book depth for a market
- Viewing historical price series

## When NOT to Use

- Placing, amending, or canceling orders (use polymarket_trade instead)
- General web research unrelated to Polymarket data (use web_search instead)

## Usage Notes

- Call ONCE with the complete natural language query
- Prices are DECIMAL probabilities in [0,1]: 0.56 = $0.56 per share = 56% implied probability
- Identifiers are URL slugs, not tickers: "xi-jinping-out-before-2027", "world-cup-winner"
- Outcome prices across a market sum to ~1.0
`.trim();

/** Format snake_case tool name to Title Case for progress messages */
function formatSubToolName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const MARKET_DATA_TOOLS: StructuredToolInterface[] = [
  searchEventsTool,
  getMarkets,
  getMarket,
  getMarketOrderbook,
  getMarketPriceHistory,
  getEvents,
  getEvent,
  getSeries,
  getExchangeStatus,
];

/** Tools that need a configured wallet; every one throws without an address. */
const WALLET_TOOLS: StructuredToolInterface[] = [getBalance, getPositions];

/**
 * The routable tool set, resolved per call rather than once at module load.
 *
 * The wallet tools are offered only when an address is configured. Handing them
 * to the router unconditionally is a hole in the gating: the top-level registry
 * withholds the portfolio tools, but this meta-tool would route to them one
 * layer down and they would throw. Advertising a capability and then failing on
 * it is worse than not advertising it — the agent has no way to tell that
 * failure apart from a genuine outage.
 */
function polymarketReadTools(): StructuredToolInterface[] {
  return getWalletAddress()
    ? [...MARKET_DATA_TOOLS, ...WALLET_TOOLS]
    : MARKET_DATA_TOOLS;
}

function polymarketToolMap(): Map<string, StructuredToolInterface> {
  return new Map(polymarketReadTools().map((t) => [t.name, t]));
}

/** Names the router may currently route to. Exported so the gating is testable. */
export function polymarketReadToolNames(): string[] {
  return polymarketReadTools().map((t) => t.name);
}

function buildRouterPrompt(): string {
  return `You are a Polymarket prediction market data routing assistant.
Current date: ${getCurrentDate()}

You MUST call at least one tool. Never respond with text alone — always call a tool to fetch live data.

## CRITICAL: Use search_events for Topic Queries
The /events endpoint has NO keyword filter and silently ignores unknown params, so a
"title" filter would quietly return unrelated results. search_events is the only real
full-text search. ALWAYS use it to find markets by topic:
- "Fed decision in June" -> search_events(query="fed decision")
- "Tesla deliveries" -> search_events(query="tesla")
- "Bitcoin price" -> search_events(query="bitcoin")

Use short, broad keywords. Prefer single words or two-word phrases — never full sentences.

## Multi-Step Strategy

You may be called multiple times with accumulated results. Follow this pattern:

1. **Search by keyword**: search_events(query="keyword") — returns events with nested markets and live prices
2. **Broaden**: If nothing comes back, try a shorter or more general keyword
3. **Drill down**: Once you have an event slug, call get_event(event_ticker="<slug>") for every market in it
4. **Complete**: When you have sufficient data (especially prices/probabilities), respond with text only — do NOT call more tools

search_events usually returns prices directly, so step 3 is often unnecessary.

## Tool Selection

- **Topic search** -> search_events(query="keyword")
- **Known event slug** -> get_event(event_ticker="world-cup-winner")
- **Known market slug / condition id / URL** -> get_market(ticker="xi-jinping-out-before-2027")
- **Order book depth** -> get_market_orderbook(ticker=...)
- **Price history** -> get_market_price_history(ticker=..., interval="1d")
${getWalletAddress() ? `- **Portfolio value** -> get_balance
- **Open positions** -> get_positions
` : ''}- **CLOB reachable?** -> get_exchange_status

## Identifier Formats
Polymarket uses URL slugs, not tickers:
- Series: nfl, epl
- Event: world-cup-winner, us-recession-in-2026
- Market: will-switzerland-win-the-2026-fifa-world-cup
- Condition id: 0x… (64 hex chars) also accepted by get_market

## Price Interpretation
- Prices are DECIMAL probabilities in [0,1]: 0.56 = $0.56 = 56% implied probability
- Outcome prices within a market sum to ~1.0
- Outcomes are NOT always Yes/No — a sports market may be ["Team A","Team B"]

Call the appropriate tool(s) now.`;
}

export interface SubToolResult {
  tool: string;
  args: Record<string, unknown>;
  data: unknown;
  error: string | null;
}

async function executeToolCalls(toolCalls: ToolCall[]): Promise<SubToolResult[]> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      try {
        const tool = polymarketToolMap().get(tc.name);
        if (!tool) throw new Error(`Tool '${tc.name}' not found`);
        const rawResult = await tool.invoke(tc.args);
        const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        const parsed = JSON.parse(result);
        return { tool: tc.name, args: tc.args as Record<string, unknown>, data: parsed.data, error: null };
      } catch (error) {
        return {
          tool: tc.name,
          args: tc.args as Record<string, unknown>,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

function buildFollowUpPrompt(originalQuery: string, allResults: SubToolResult[]): string {
  const resultsText = allResults
    .map((r) => {
      const header = `[${r.tool}(${JSON.stringify(r.args)})]`;
      if (r.error) return `${header} ERROR: ${r.error}`;
      return `${header}\n${JSON.stringify(r.data, null, 2)}`;
    })
    .join('\n\n');

  return `Original query: ${originalQuery}

Data retrieved so far:
${resultsText}

If you have sufficient data (especially prices/probabilities) to answer the query, respond with text only — do NOT call more tools.
Otherwise, call the next tool(s) needed to drill down (e.g. get_event with with_nested_markets=true for contract-level prices).`;
}

interface ExtractedEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  /** Full Polymarket event URL for Octagon */
  url?: string;
  /** Source priority: get_event (drill-down) > get_events (list) */
  priority: number;
}

/**
 * Build the canonical Polymarket event URL.
 *
 * Far simpler than the Kalshi equivalent, which had to fetch the series title to
 * synthesise a slug. Polymarket event slugs ARE the URL path.
 */
export async function buildPolymarketEventUrl(
  _seriesTicker: string | undefined,
  eventTicker: string,
): Promise<string | undefined> {
  if (!eventTicker) return undefined;
  return `https://polymarket.com/event/${eventTicker.toLowerCase()}`;
}

/**
 * Extract unique events from sub-tool results for octagon_report.
 * Returns events sorted by relevance: drill-down results first.
 * Octagon needs event-level URLs: https://polymarket.com/event/{event_slug}
 * Exported for testing.
 */
export function extractEventsFromResults(results: SubToolResult[]): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  const seen = new Set<string>();

  function addEvent(eventTicker: string, seriesTicker?: string, title?: string, priority = 0) {
    if (seen.has(eventTicker)) {
      // Upgrade priority if this source is higher priority
      const existing = events.find(e => e.event_ticker === eventTicker);
      if (existing && priority > existing.priority) {
        existing.priority = priority;
        if (seriesTicker && !existing.series_ticker) existing.series_ticker = seriesTicker;
        if (title && !existing.title) existing.title = title;
      }
      return;
    }
    seen.add(eventTicker);
    // URL is resolved async later via buildPolymarketEventUrl — not set here
    events.push({ event_ticker: eventTicker, series_ticker: seriesTicker, title, url: undefined, priority });
  }

  for (const r of results) {
    if (r.error || !r.data) continue;
    const data = r.data as Record<string, unknown>;

    // From get_events (list): lower priority
    const eventsList = (data.events ?? []) as Array<Record<string, unknown>>;
    for (const event of eventsList) {
      const eventTicker = event.event_ticker as string | undefined;
      if (eventTicker) {
        addEvent(eventTicker, event.series_ticker as string | undefined, event.title as string | undefined, 0);
      }
    }

    // From get_event (drill-down): highest priority — the LLM chose this event
    const singleEvent = data.event as Record<string, unknown> | undefined;
    if (singleEvent?.event_ticker) {
      addEvent(
        singleEvent.event_ticker as string,
        singleEvent.series_ticker as string | undefined,
        singleEvent.title as string | undefined,
        2
      );
    }

    // From get_market: extract event_ticker
    if (data.market && typeof data.market === 'object') {
      const market = data.market as Record<string, unknown>;
      if (market.event_ticker && typeof market.event_ticker === 'string') {
        addEvent(market.event_ticker, market.series_ticker as string | undefined, undefined, 1);
      }
    }
  }

  // Sort by priority (drill-down first)
  events.sort((a, b) => b.priority - a.priority);

  return events;
}

/** Extract market ticker strings (for backward compatibility with tests) */
export function extractTickersFromResults(results: SubToolResult[]): string[] {
  const tickers: string[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.error || !r.data) continue;
    const data = r.data as Record<string, unknown>;
    const eventsList = (data.events ?? []) as Array<Record<string, unknown>>;
    for (const event of eventsList) {
      for (const market of (event.markets ?? []) as Array<Record<string, unknown>>) {
        if (market.ticker && typeof market.ticker === 'string' && !seen.has(market.ticker)) {
          seen.add(market.ticker);
          tickers.push(market.ticker);
        }
      }
    }
    const singleEvent = data.event as Record<string, unknown> | undefined;
    if (singleEvent?.markets) {
      for (const market of singleEvent.markets as Array<Record<string, unknown>>) {
        if (market.ticker && typeof market.ticker === 'string' && !seen.has(market.ticker)) {
          seen.add(market.ticker);
          tickers.push(market.ticker);
        }
      }
    }
    if (data.market && typeof data.market === 'object') {
      const market = data.market as Record<string, unknown>;
      if (market.ticker && typeof market.ticker === 'string' && !seen.has(market.ticker)) {
        seen.add(market.ticker);
        tickers.push(market.ticker);
      }
    }
  }
  return tickers;
}

/** @deprecated Use extractEventsFromResults instead */
export function extractMarketsFromResults(results: SubToolResult[]) {
  return extractEventsFromResults(results);
}

const MAX_ITERATIONS = 3;

const PolymarketSearchInputSchema = z.object({
  query: z.string().describe('Natural language query about Polymarket markets or portfolio'),
});

export function createPolymarketSearch(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'polymarket_search',
    description: POLYMARKET_SEARCH_DESCRIPTION,
    schema: PolymarketSearchInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      const allResults: SubToolResult[] = [];
      const systemPrompt = buildRouterPrompt();

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const isFirst = iteration === 0;

        onProgress?.(
          isFirst
            ? 'Searching Polymarket...'
            : iteration === 1
              ? 'Drilling down into results...'
              : 'Analyzing results...'
        );

        const prompt = isFirst ? input.query : buildFollowUpPrompt(input.query, allResults);

        const { response } = await callLlm(prompt, {
          model,
          systemPrompt,
          tools: polymarketReadTools(),
          toolChoice: isFirst ? 'required' : 'auto',
        });
        const aiMessage = response as AIMessage;

        const toolCalls = aiMessage.tool_calls as ToolCall[];
        if (!toolCalls || toolCalls.length === 0) {
          // No tool calls — LLM decided it has enough data (or first iteration failed)
          if (isFirst) {
            return formatToolResult({ error: 'No tools selected for query' });
          }
          break;
        }

        const toolNames = [...new Set(toolCalls.map((tc) => formatSubToolName(tc.name)))];
        onProgress?.(`Fetching ${toolNames.join(', ')}...`);

        const results = await executeToolCalls(toolCalls);
        allResults.push(...results);
      }

      // Build combined data from all iterations
      const combinedData: Record<string, unknown> = {};
      for (const result of allResults.filter((r) => r.error === null)) {
        const ticker = result.args.ticker as string | undefined;
        const eventTicker = result.args.event_ticker as string | undefined;
        const key = ticker
          ? `${result.tool}_${ticker}`
          : eventTicker
            ? `${result.tool}_${eventTicker}`
            : result.tool;
        combinedData[key] = result.data;
      }

      const failed = allResults.filter((r) => r.error !== null);
      if (failed.length > 0) {
        combinedData._errors = failed.map((r) => ({ tool: r.tool, error: r.error }));
      }

      // Auto-call octagon_report for the most relevant event
      const extractedEvents = extractEventsFromResults(allResults);
      logger.info(`[polymarket-search] Extracted ${extractedEvents.length} events from ${allResults.length} results`);
      if (extractedEvents.length > 0) {
        const target = extractedEvents[0];
        onProgress?.('Fetching Octagon report...');
        try {
          // Polymarket event slugs are the URL path — no lookup needed
          let octagonInput = target.event_ticker;
          if (target.series_ticker) {
            const url = await buildPolymarketEventUrl(target.series_ticker, target.event_ticker);
            if (url) octagonInput = url;
          }
          logger.info(`[polymarket-search] Auto-calling octagon_report for ${octagonInput}`);
          const octagonResult = await octagonReportTool.invoke({ ticker: octagonInput });
          const parsed = typeof octagonResult === 'string' ? JSON.parse(octagonResult) : octagonResult;
          combinedData.octagon_report = parsed.data ?? parsed;
          logger.info(`[polymarket-search] octagon_report succeeded`);
        } catch (error) {
          logger.warn(`[polymarket-search] octagon_report failed:`, error);
          combinedData._octagon_error = error instanceof Error ? error.message : String(error);
        }
      } else {
        logger.warn(`[polymarket-search] No events found in results, skipping octagon_report`);
      }

      return formatToolResult(combinedData);
    },
  });
}
