/**
 * Integration tests for all Kalshi sub-tools + slash commands + kalshi_search router.
 *
 * These hit the LIVE Kalshi API (prod or demo depending on .env).
 * No trades are placed — all tests are read-only.
 *
 * Run: bun test src/tools/kalshi/integration.test.ts
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import 'dotenv/config';

// ─── Sub-tools (direct API wrappers) ────────────────────────────────────────

import { getMarkets, getMarket, getMarketOrderbook, getMarketCandlesticks } from './markets.js';
import { getEvents, getEvent } from './events.js';
import { getSeries } from './series.js';
import {
  getBalance,
  getPositions,
  getFills,
  getSettlements,
  getOrders,
  getOrder,
} from './portfolio.js';
import {
  getHistoricalMarkets,
  getHistoricalMarket,
  getHistoricalCandlesticks,
  getHistoricalFills,
  getHistoricalOrders,
} from './historical.js';
import { getExchangeStatus, getExchangeSchedule } from './exchange.js';

// ─── Slash commands ─────────────────────────────────────────────────────────

import { handleSlashCommand } from '../../commands/index.js';

// ─── Router (kalshi_search) ─────────────────────────────────────────────────

import { createKalshiSearch } from './kalshi-search.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse the JSON wrapper that formatToolResult produces */
function parseResult(raw: string): any {
  const outer = JSON.parse(raw);
  return outer.data;
}

/** Timeout for API calls */
const TIMEOUT = 30_000;

// We'll discover a live market ticker in beforeAll to use in subsequent tests
let liveMarketTicker: string;
let liveEventTicker: string;
let liveSeriesTicker: string;

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Kalshi Integration Tests', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. EXCHANGE STATUS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Exchange Tools', () => {
    test('get_exchange_status returns active/trading flags', async () => {
      const raw = await getExchangeStatus.invoke({});
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(typeof data.exchange_active).toBe('boolean');
      expect(typeof data.trading_active).toBe('boolean');
      console.log(`  Exchange active: ${data.exchange_active}, Trading: ${data.trading_active}`);
    }, TIMEOUT);

    test('get_exchange_schedule returns schedule array', async () => {
      const raw = await getExchangeSchedule.invoke({});
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(data.schedule).toBeDefined();
      console.log(`  Schedule entries: ${data.schedule?.length ?? 'unknown'}`);
    }, TIMEOUT);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. EVENT & SERIES TOOLS (+ discover tickers for later tests)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Event & Series Tools', () => {
    test('get_events returns open events and we discover tickers', async () => {
      const raw = await getEvents.invoke({ status: 'open', limit: 10 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const events = data.events ?? data;
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // Pick first event for subsequent tests
      const ev = events[0];
      liveEventTicker = ev.event_ticker;
      liveSeriesTicker = ev.series_ticker;
      console.log(`  Found ${events.length} open events. Using event: ${liveEventTicker}, series: ${liveSeriesTicker}`);
    }, TIMEOUT);

    test('get_event returns details for a known event', async () => {
      expect(liveEventTicker).toBeDefined();
      const raw = await getEvent.invoke({ event_ticker: liveEventTicker });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const event = data.event ?? data;
      expect(event.event_ticker).toBe(liveEventTicker);
      console.log(`  Event title: ${event.title}`);
    }, TIMEOUT);

    test('get_event with nested markets includes market data', async () => {
      expect(liveEventTicker).toBeDefined();
      const raw = await getEvent.invoke({
        event_ticker: liveEventTicker,
        with_nested_markets: true,
      });
      const data = parseResult(raw as string);
      const event = data.event ?? data;
      const markets = event.markets ?? [];
      expect(Array.isArray(markets)).toBe(true);
      console.log(`  Event ${liveEventTicker} has ${markets.length} nested markets`);

      // Pick a market ticker for later tests
      if (markets.length > 0) {
        liveMarketTicker = markets[0].ticker;
        console.log(`  Using market ticker: ${liveMarketTicker}`);
      }
    }, TIMEOUT);

    test('get_series returns series metadata', async () => {
      expect(liveSeriesTicker).toBeDefined();
      const raw = await getSeries.invoke({ series_ticker: liveSeriesTicker });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const series = data.series ?? data;
      console.log(`  Series: ${series.title ?? liveSeriesTicker}, category: ${series.category ?? 'unknown'}`);
    }, TIMEOUT);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. MARKET TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Market Tools', () => {
    test('get_markets returns a list of open markets', async () => {
      const raw = await getMarkets.invoke({ status: 'open', limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const markets = data.markets ?? data;
      expect(Array.isArray(markets)).toBe(true);
      expect(markets.length).toBeGreaterThan(0);

      // Ensure we have a market ticker even if event discovery didn't yield one
      if (!liveMarketTicker) {
        liveMarketTicker = markets[0].ticker;
        console.log(`  Fallback market ticker: ${liveMarketTicker}`);
      }
      console.log(`  Got ${markets.length} markets`);
    }, TIMEOUT);

    test('get_markets filters by event_ticker', async () => {
      expect(liveEventTicker).toBeDefined();
      const raw = await getMarkets.invoke({ event_ticker: liveEventTicker, limit: 5 });
      const data = parseResult(raw as string);
      const markets = data.markets ?? data;
      expect(Array.isArray(markets)).toBe(true);
      console.log(`  Markets for event ${liveEventTicker}: ${markets.length}`);
    }, TIMEOUT);

    test('get_markets filters by series_ticker', async () => {
      expect(liveSeriesTicker).toBeDefined();
      const raw = await getMarkets.invoke({ series_ticker: liveSeriesTicker, limit: 5 });
      const data = parseResult(raw as string);
      const markets = data.markets ?? data;
      expect(Array.isArray(markets)).toBe(true);
      console.log(`  Markets for series ${liveSeriesTicker}: ${markets.length}`);
    }, TIMEOUT);

    test('get_market returns single market details', async () => {
      expect(liveMarketTicker).toBeDefined();
      const raw = await getMarket.invoke({ ticker: liveMarketTicker });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const mkt = data.market ?? data;
      expect(mkt.ticker).toBe(liveMarketTicker);
      console.log(`  Market: ${mkt.title}, status: ${mkt.status}`);
    }, TIMEOUT);

    test('get_market_orderbook returns bid/ask levels', async () => {
      expect(liveMarketTicker).toBeDefined();
      const raw = await getMarketOrderbook.invoke({ ticker: liveMarketTicker });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      // API may return {orderbook: {yes, no}} or flat {yes, no}
      const ob = data.orderbook ?? data;
      // Some low-liquidity markets may have empty orderbooks
      console.log(`  Orderbook keys: ${Object.keys(ob).join(', ')}`);
      console.log(`  Orderbook: ${ob.yes?.length ?? 0} YES levels, ${ob.no?.length ?? 0} NO levels`);
    }, TIMEOUT);

    test('get_market_candlesticks returns OHLC data', async () => {
      expect(liveMarketTicker).toBeDefined();
      const now = Math.floor(Date.now() / 1000);
      const raw = await getMarketCandlesticks.invoke({
        ticker: liveMarketTicker,
        start_ts: now - 7 * 24 * 3600,
        end_ts: now,
        period_interval: 60,
      });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const candles = data.candlesticks ?? data;
      // Candlesticks may be empty for new/illiquid markets
      const count = Array.isArray(candles) ? candles.length : 'n/a';
      console.log(`  Candlesticks for ${liveMarketTicker}: ${count}`);
    }, TIMEOUT);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. PORTFOLIO TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Portfolio Tools', () => {
    test('get_balance returns account balance', async () => {
      const raw = await getBalance.invoke({});
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(typeof data.balance).toBe('number');
      console.log(`  Balance: ${data.balance} cents`);
    }, TIMEOUT);

    test('get_positions returns positions array', async () => {
      const raw = await getPositions.invoke({});
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const positions = data.market_positions ?? data.positions ?? [];
      expect(Array.isArray(positions)).toBe(true);
      console.log(`  Open positions: ${positions.length}`);
    }, TIMEOUT);

    test('get_fills returns fills array', async () => {
      const raw = await getFills.invoke({ limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const fills = data.fills ?? [];
      expect(Array.isArray(fills)).toBe(true);
      console.log(`  Recent fills: ${fills.length}`);
    }, TIMEOUT);

    test('get_settlements returns settlements array', async () => {
      const raw = await getSettlements.invoke({ limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const settlements = data.settlements ?? [];
      expect(Array.isArray(settlements)).toBe(true);
      console.log(`  Settlements: ${settlements.length}`);
    }, TIMEOUT);

    test('get_orders returns orders array', async () => {
      const raw = await getOrders.invoke({ status: 'all', limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const orders = data.orders ?? [];
      expect(Array.isArray(orders)).toBe(true);
      console.log(`  Orders (all): ${orders.length}`);
    }, TIMEOUT);

    test('get_orders with resting status', async () => {
      const raw = await getOrders.invoke({ status: 'resting' });
      const data = parseResult(raw as string);
      const orders = data.orders ?? [];
      expect(Array.isArray(orders)).toBe(true);
      console.log(`  Resting orders: ${orders.length}`);
    }, TIMEOUT);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. HISTORICAL TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Historical Tools', () => {
    let settledMarketTicker: string | undefined;

    test('get_historical_markets returns settled markets', async () => {
      const raw = await getHistoricalMarkets.invoke({ status: 'settled', limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const markets = data.markets ?? data;
      expect(Array.isArray(markets)).toBe(true);
      if (markets.length > 0) {
        settledMarketTicker = markets[0].ticker;
        console.log(`  Historical markets: ${markets.length}, using: ${settledMarketTicker}`);
      } else {
        console.log('  No settled markets found (may be new account)');
      }
    }, TIMEOUT);

    test('get_historical_market returns single settled market', async () => {
      if (!settledMarketTicker) {
        console.log('  Skipped (no settled market found)');
        return;
      }
      const raw = await getHistoricalMarket.invoke({ ticker: settledMarketTicker });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      const mkt = data.market ?? data;
      console.log(`  Historical market: ${mkt.title ?? settledMarketTicker}, result: ${mkt.result ?? 'unknown'}`);
    }, TIMEOUT);

    test('get_historical_candlesticks returns data', async () => {
      if (!settledMarketTicker) {
        console.log('  Skipped (no settled market found)');
        return;
      }
      const raw = await getHistoricalCandlesticks.invoke({
        ticker: settledMarketTicker,
        period_interval: 60,
      });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      const candles = data.candlesticks ?? data;
      const count = Array.isArray(candles) ? candles.length : 'n/a';
      console.log(`  Historical candlesticks: ${count}`);
    }, TIMEOUT);

    test('get_historical_fills returns past fills', async () => {
      const raw = await getHistoricalFills.invoke({ limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      const fills = data.fills ?? [];
      expect(Array.isArray(fills)).toBe(true);
      console.log(`  Historical fills: ${fills.length}`);
    }, TIMEOUT);

    test('get_historical_orders returns past orders', async () => {
      const raw = await getHistoricalOrders.invoke({ limit: 5 });
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      const orders = data.orders ?? [];
      expect(Array.isArray(orders)).toBe(true);
      console.log(`  Historical orders: ${orders.length}`);
    }, TIMEOUT);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. SLASH COMMANDS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Slash Commands', () => {
    test('/help returns command list', async () => {
      const result = await handleSlashCommand('/help');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('/analyze');
      expect(result!.output).toContain('/search');
      expect(result!.output).toContain('/portfolio');
      expect(result!.output).toContain('/watch');
      expect(result!.output).toContain('/buy');
      expect(result!.output).toContain('/sell');
      expect(result!.output).toContain('/cancel');
      expect(result!.output).toContain('/help');
      console.log('  /help OK');
    });

    test('/events returns event listing', async () => {
      const result = await handleSlashCommand('/events');
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      expect(result!.output.length).toBeGreaterThan(10);
      console.log(`  /events: ${result!.output.split('\n').length} lines`);
    }, TIMEOUT);

    test('/events with series filter', async () => {
      expect(liveSeriesTicker).toBeDefined();
      const result = await handleSlashCommand(`/events ${liveSeriesTicker}`);
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      console.log(`  /events ${liveSeriesTicker}: ${result!.output.split('\n').length} lines`);
    }, TIMEOUT);

    test('/event <ticker> returns event detail with markets', async () => {
      expect(liveEventTicker).toBeDefined();
      const result = await handleSlashCommand(`/event ${liveEventTicker}`);
      expect(result).not.toBeNull();
      expect(result!.output).toContain(liveEventTicker);
      console.log(`  /event: ${result!.output.split('\n')[0]}`);
    }, TIMEOUT);

    test('/event without args returns usage', async () => {
      const result = await handleSlashCommand('/event');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Usage');
      console.log('  /event (no args) shows usage');
    });

    test('/status returns exchange status', async () => {
      const result = await handleSlashCommand('/status');
      expect(result).not.toBeNull();
      expect(result!.output).toMatch(/Exchange/i);
      expect(result!.output).toMatch(/Trading/i);
      console.log(`  /status: ${result!.output}`);
    }, TIMEOUT);

    test('/balance returns account balance', async () => {
      const result = await handleSlashCommand('/balance');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Balance');
      console.log(`  /balance: ${result!.output.split('\n')[2]}`);
    }, TIMEOUT);

    test('/positions returns positions', async () => {
      const result = await handleSlashCommand('/positions');
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      console.log(`  /positions: ${result!.output.split('\n')[0]}`);
    }, TIMEOUT);

    test('/orders returns orders', async () => {
      const result = await handleSlashCommand('/orders');
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      console.log(`  /orders: ${result!.output.split('\n')[0]}`);
    }, TIMEOUT);

    test('/markets returns market listing', async () => {
      const result = await handleSlashCommand('/markets');
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      expect(result!.output.length).toBeGreaterThan(10);
      console.log(`  /markets: ${result!.output.split('\n').length} lines`);
    }, TIMEOUT);

    test('/markets with series filter', async () => {
      expect(liveSeriesTicker).toBeDefined();
      const result = await handleSlashCommand(`/markets ${liveSeriesTicker}`);
      expect(result).not.toBeNull();
      expect(result!.output).toBeDefined();
      console.log(`  /markets ${liveSeriesTicker}: ${result!.output.split('\n').length} lines`);
    }, TIMEOUT);

    test('/market <ticker> returns market detail + orderbook', async () => {
      expect(liveMarketTicker).toBeDefined();
      const result = await handleSlashCommand(`/market ${liveMarketTicker}`);
      expect(result).not.toBeNull();
      expect(result!.output).toContain(liveMarketTicker);
      expect(result!.output).toMatch(/YES/i);
      console.log(`  /market: ${result!.output.split('\n')[0]}`);
    }, TIMEOUT);

    test('/buy without args returns usage', async () => {
      const result = await handleSlashCommand('/buy');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Usage');
      expect(result!.pendingTrade).toBeUndefined();
      console.log('  /buy (no args) shows usage');
    });

    test('/buy with args returns order preview (no execution)', async () => {
      const result = await handleSlashCommand('/buy FAKE-TICKER 1 50');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Order Preview');
      expect(result!.output).toContain('FAKE-TICKER');
      expect(result!.pendingTrade).toBeDefined();
      expect(result!.pendingTrade!.action).toBe('buy');
      expect(result!.pendingTrade!.count).toBe(1);
      expect(result!.pendingTrade!.price).toBe(50);
      console.log('  /buy preview OK (not executed)');
    });

    test('/sell with args returns order preview (no execution)', async () => {
      const result = await handleSlashCommand('/sell FAKE-TICKER 3 75');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Order Preview');
      expect(result!.pendingTrade!.action).toBe('sell');
      expect(result!.pendingTrade!.count).toBe(3);
      expect(result!.pendingTrade!.price).toBe(75);
      console.log('  /sell preview OK (not executed)');
    });

    test('/buy with invalid price rejects', async () => {
      const result = await handleSlashCommand('/buy FAKE-TICKER 1 150');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Invalid price');
      expect(result!.pendingTrade).toBeUndefined();
      console.log('  /buy invalid price rejected');
    });

    test('/cancel without args returns usage', async () => {
      const result = await handleSlashCommand('/cancel');
      expect(result).not.toBeNull();
      expect(result!.output).toContain('Usage');
      console.log('  /cancel (no args) shows usage');
    });

    test('non-slash input returns null', async () => {
      const result = await handleSlashCommand('just a normal query');
      expect(result).toBeNull();
      console.log('  Non-slash returns null');
    });

    test('unknown slash command returns null', async () => {
      const result = await handleSlashCommand('/foobar');
      expect(result).toBeNull();
      console.log('  Unknown slash returns null');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. POLYMARKET_SEARCH ROUTER (multi-step agentic)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('kalshi_search Router', () => {
    // Use a fast model for router tests to avoid timeouts — gpt-5 is too slow for 3 iterations
    const model = 'gpt-4.1-mini';
    let searchTool: ReturnType<typeof createKalshiSearch>;

    beforeAll(() => {
      searchTool = createKalshiSearch(model);
    });

    test('direct ticker query returns market data in ~1 iteration', async () => {
      expect(liveMarketTicker).toBeDefined();
      const progressMessages: string[] = [];
      const raw = await searchTool.invoke(
        { query: `price of ${liveMarketTicker}` },
        { metadata: { onProgress: (msg: string) => progressMessages.push(msg) } } as any
      );
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(Object.keys(data).length).toBeGreaterThan(0);

      // Should have at least "Searching Kalshi..." progress
      expect(progressMessages.length).toBeGreaterThan(0);
      expect(progressMessages[0]).toBe('Searching Kalshi...');

      console.log(`  Direct ticker query: ${Object.keys(data).join(', ')}`);
      console.log(`  Progress: ${progressMessages.join(' → ')}`);
    }, 60_000);

    test('topic query drills down across multiple iterations', async () => {
      const progressMessages: string[] = [];
      const raw = await searchTool.invoke(
        { query: 'What are the current Bitcoin prediction markets on Kalshi?' },
        { metadata: { onProgress: (msg: string) => progressMessages.push(msg) } } as any
      );
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(Object.keys(data).length).toBeGreaterThan(0);

      console.log(`  Topic query keys: ${Object.keys(data).join(', ')}`);
      console.log(`  Progress: ${progressMessages.join(' → ')}`);

      // Should have gone through at least initial search
      expect(progressMessages.length).toBeGreaterThan(0);
    }, 180_000);

    test('portfolio query returns balance/position data', async () => {
      const progressMessages: string[] = [];
      const raw = await searchTool.invoke(
        { query: "What's my Kalshi balance?" },
        { metadata: { onProgress: (msg: string) => progressMessages.push(msg) } } as any
      );
      const data = parseResult(raw as string);
      expect(data).toBeDefined();

      // Should contain balance data
      const keys = Object.keys(data);
      const hasBalance = keys.some((k) => k.includes('balance'));
      expect(hasBalance).toBe(true);
      console.log(`  Portfolio query keys: ${keys.join(', ')}`);
    }, 60_000);

    test('exchange status query works', async () => {
      const raw = await searchTool.invoke(
        { query: 'Is the Kalshi exchange currently open?' },
        {} as any
      );
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      const keys = Object.keys(data);
      const hasExchange = keys.some((k) => k.includes('exchange'));
      expect(hasExchange).toBe(true);
      console.log(`  Exchange query keys: ${keys.join(', ')}`);
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. PORTFOLIO OVERVIEW (composite tool)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Portfolio Overview (composite)', () => {
    test('returns balance + positions in one call', async () => {
      // Import the registry to get the composite tool
      const { getToolRegistry } = await import('../registry.js');
      const tools = getToolRegistry('test-model');
      const overviewTool = tools.find((t) => t.name === 'portfolio_overview');
      expect(overviewTool).toBeDefined();

      const raw = await overviewTool!.tool.invoke({});
      const data = parseResult(raw as string);
      expect(data).toBeDefined();
      expect(data.balance).toBeDefined();
      expect(data.positions).toBeDefined();
      console.log(`  Balance: ${data.balance.balance} cents, Positions: ${JSON.stringify(data.positions).length > 5 ? 'present' : 'empty'}`);
    }, TIMEOUT);
  });
});
