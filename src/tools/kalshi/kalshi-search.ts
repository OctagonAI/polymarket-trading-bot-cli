import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { octagonReportTool } from '../v2/octagon-report.js';
import { callKalshiApi } from './api.js';
import { logger } from '../../utils/logger.js';

// All read-only Kalshi tools available for routing
import { getMarkets, getMarket, getMarketOrderbook, getMarketCandlesticks } from './markets.js';
import { getEvents, getEvent } from './events.js';
import { getSeries } from './series.js';
import { getBalance, getPositions, getFills, getSettlements, getOrders, getOrder } from './portfolio.js';
import { getHistoricalMarkets, getHistoricalMarket, getHistoricalCandlesticks, getHistoricalFills, getHistoricalOrders } from './historical.js';
import { getExchangeStatus, getExchangeSchedule } from './exchange.js';

export const POLYMARKET_SEARCH_DESCRIPTION = `
Intelligent meta-tool for Kalshi prediction market research. Takes a natural language query and automatically routes to appropriate Kalshi data sources.

## When to Use

- Finding markets by topic, category, or keyword
- Getting market prices (yes/no bid/ask), volume, and close dates
- Fetching event details and related markets
- Checking portfolio balance, positions, fills, and orders
- Getting orderbook depth for a specific market
- Viewing historical market data and candlestick price charts
- Checking exchange status and trading schedule

## When NOT to Use

- Placing, amending, or canceling orders (use kalshi_trade instead)
- General web research unrelated to Kalshi data (use web_search instead)

## Usage Notes

- Call ONCE with the complete natural language query
- Prices are in cents: 56 = $0.56 = 56% implied probability
- Tickers follow patterns: KXBTC-26MAR-B50000, PRES-2024-DJT
- YES price + NO price = ~100 cents (the complement)
`.trim();

/** Format snake_case tool name to Title Case for progress messages */
function formatSubToolName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const POLYMARKET_READ_TOOLS: StructuredToolInterface[] = [
  getMarkets,
  getMarket,
  getMarketOrderbook,
  getMarketCandlesticks,
  getEvents,
  getEvent,
  getSeries,
  getBalance,
  getPositions,
  getFills,
  getSettlements,
  getOrders,
  getOrder,
  getHistoricalMarkets,
  getHistoricalMarket,
  getHistoricalCandlesticks,
  getHistoricalFills,
  getHistoricalOrders,
  getExchangeStatus,
  getExchangeSchedule,
];

const POLYMARKET_TOOL_MAP = new Map(POLYMARKET_READ_TOOLS.map((t) => [t.name, t]));

function buildRouterPrompt(): string {
  return `You are a Kalshi prediction market data routing assistant.
Current date: ${getCurrentDate()}

You MUST call at least one tool. Never respond with text alone — always call a tool to fetch live data.

## CRITICAL: Use Title Search
The Kalshi API has no keyword search endpoint, but get_events supports a "title" parameter that filters events by title keywords (case-insensitive substring match). ALWAYS use this to find events by topic:
- "Fed decision in June" → get_events(title="fed decision", status="open", with_nested_markets=true)
- "Tesla deliveries" → get_events(title="tesla", status="open", with_nested_markets=true)
- "Bitcoin price" → get_events(title="bitcoin", status="open", with_nested_markets=true)
- "inflation" → get_events(title="inflation", status="open", with_nested_markets=true)

Use short, broad keywords for the title filter. Prefer single words or two-word phrases — do NOT pass full sentences.

Only fall back to get_events(status="open", limit=200) without a title filter if the topic is extremely vague.

## Multi-Step Strategy

You may be called multiple times with accumulated results. Follow this pattern:

1. **Search by title**: Extract keywords from the query and call get_events(title="keyword", status="open", with_nested_markets=true)
2. **Browse**: If title search returns nothing, broaden the keyword or use get_events(status="open", limit=200)
3. **Drill down**: Once you find relevant event tickers, call get_event(event_ticker="...", with_nested_markets=true) for contract-level prices
4. **Complete**: When you have sufficient data (especially prices/probabilities), respond with text only — do NOT call more tools

Always prefer get_event(..., with_nested_markets=true) when you need prices for a known event.

## Tool Selection

- **Topic search** → get_events(title="keyword", status="open", with_nested_markets=true)
- **Broad browse** → get_events(status="open", limit=200) — only if title search fails
- **Known event ticker** → get_event(event_ticker="KXBTC-26MAR", with_nested_markets=true)
- **Known market ticker** → get_market(ticker="KXBTC-26MAR-B80000")
- **Orderbook depth** → get_market_orderbook(ticker=...)
- **Price history** → get_market_candlesticks or get_historical_candlesticks
- **Portfolio balance** → get_balance
- **Open positions** → get_positions
- **Recent fills** → get_fills
- **Resting orders** → get_orders(status="resting")
- **Exchange open?** → get_exchange_status

## Ticker Formats
- Series: KXBTC, KXPRES, KXETH
- Event: KXBTC-26MAR, KXPRES-28
- Market: KXBTC-26MAR-B80000, KXPRES-28-DJT

## Price Interpretation
- Prices are in cents (1–99): 56 = $0.56 = 56% implied probability
- YES + NO prices ≈ 100 cents

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
        const tool = POLYMARKET_TOOL_MAP.get(tc.name);
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
  /** Full Kalshi event URL for Octagon */
  url?: string;
  /** Source priority: get_event (drill-down) > get_events (list) */
  priority: number;
}

/**
 * Convert a title to a URL slug.
 */
function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Cache series title lookups to avoid repeated API calls */
const seriesTitleCache = new Map<string, string>();

/**
 * Build the correct Kalshi event URL by fetching the series title for the slug.
 * URL format: https://kalshi.com/markets/{series_ticker}/{series_slug}/{event_ticker}
 * The slug comes from the series title (e.g. "Tesla deliveries" → "tesla-deliveries"),
 * NOT the event title.
 */
export async function buildKalshiEventUrl(seriesTicker: string, eventTicker: string): Promise<string | undefined> {
  try {
    let seriesTitle = seriesTitleCache.get(seriesTicker);
    if (!seriesTitle) {
      const data = await callKalshiApi('GET', `/series/${seriesTicker}`);
      const series = (data.series ?? data) as Record<string, unknown>;
      seriesTitle = series.title as string | undefined;
      if (seriesTitle) {
        seriesTitleCache.set(seriesTicker, seriesTitle);
      }
    }
    if (seriesTitle) {
      const slug = titleToSlug(seriesTitle);
      return `https://kalshi.com/markets/${seriesTicker.toLowerCase()}/${slug}/${eventTicker.toLowerCase()}`;
    }
  } catch {
    // Fall back — can't build URL without series title
  }
  return undefined;
}

/**
 * Extract unique events from sub-tool results for octagon_report.
 * Returns events sorted by relevance: drill-down results first.
 * Octagon needs event-level URLs: https://kalshi.com/markets/{series}/{title-slug}/{event_ticker}
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
    // URL is resolved async later via buildKalshiEventUrl — not set here
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

const KalshiSearchInputSchema = z.object({
  query: z.string().describe('Natural language query about Kalshi markets or portfolio'),
});

export function createKalshiSearch(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'kalshi_search',
    description: POLYMARKET_SEARCH_DESCRIPTION,
    schema: KalshiSearchInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      const allResults: SubToolResult[] = [];
      const systemPrompt = buildRouterPrompt();

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const isFirst = iteration === 0;

        onProgress?.(
          isFirst
            ? 'Searching Kalshi...'
            : iteration === 1
              ? 'Drilling down into results...'
              : 'Analyzing results...'
        );

        const prompt = isFirst ? input.query : buildFollowUpPrompt(input.query, allResults);

        const { response } = await callLlm(prompt, {
          model,
          systemPrompt,
          tools: POLYMARKET_READ_TOOLS,
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
      logger.info(`[kalshi-search] Extracted ${extractedEvents.length} events from ${allResults.length} results`);
      if (extractedEvents.length > 0) {
        const target = extractedEvents[0];
        onProgress?.('Fetching Octagon report...');
        try {
          // Resolve the correct Kalshi URL via series API lookup
          let octagonInput = target.event_ticker;
          if (target.series_ticker) {
            const url = await buildKalshiEventUrl(target.series_ticker, target.event_ticker);
            if (url) octagonInput = url;
          }
          logger.info(`[kalshi-search] Auto-calling octagon_report for ${octagonInput}`);
          const octagonResult = await octagonReportTool.invoke({ ticker: octagonInput });
          const parsed = typeof octagonResult === 'string' ? JSON.parse(octagonResult) : octagonResult;
          combinedData.octagon_report = parsed.data ?? parsed;
          logger.info(`[kalshi-search] octagon_report succeeded`);
        } catch (error) {
          logger.warn(`[kalshi-search] octagon_report failed:`, error);
          combinedData._octagon_error = error instanceof Error ? error.message : String(error);
        }
      } else {
        logger.warn(`[kalshi-search] No events found in results, skipping octagon_report`);
      }

      return formatToolResult(combinedData);
    },
  });
}
