import type { ParsedArgs } from './parse-args.js';
import { wrapSuccess, wrapError } from './json.js';
import { getDb } from '../db/index.js';
import { auditTrail } from '../audit/index.js';
import { ScanLoop } from '../scan/loop.js';
import { createOctagonInvoker } from '../scan/invoker.js';
import { formatScanTable } from './scan-formatters.js';
import { lookupMarket, fetchMarketOrderbook } from '../tools/polymarket/markets.js';
import { getBotSetting } from '../utils/bot-config.js';
import type { ScanResult } from '../scan/loop.js';

export async function handleWatch(args: ParsedArgs): Promise<void> {
  const db = getDb();
  const invoker = createOctagonInvoker();
  const loop = new ScanLoop(db, auditTrail, invoker);

  const rawMinInterval = Number(getBotSetting('watch.min_interval_minutes'));
  const minIntervalMinutes = Number.isFinite(rawMinInterval) && rawMinInterval > 0 ? rawMinInterval : 15;
  const intervalMinutes = args.live
    ? minIntervalMinutes
    : Math.max(minIntervalMinutes, args.interval ?? 60);
  const intervalMs = intervalMinutes * 60_000;
  const theme = args.theme ?? 'top50';

  let totalCycles = 0;
  let totalEdges = 0;
  const startTime = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval>;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(0);
    if (args.json) {
      console.log(JSON.stringify({
        event: 'watch_stopped',
        totalCycles,
        totalEdges,
        durationSeconds: Number(durationSec),
      }));
    } else {
      console.log('');
      console.log(`Watch stopped. ${totalCycles} cycles, ${totalEdges} edges found in ${durationSec}s`);
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (!args.json) {
    console.log(`Watching theme "${theme}" every ${intervalMinutes}m (Ctrl+C to stop)\n`);
  }

  const runCycle = async (): Promise<void> => {
    try {
      const result = await loop.runOnce({ theme, dryRun: args.dryRun });
      totalCycles++;
      totalEdges += result.edgeSnapshots.length;

      if (args.json) {
        const actionable = result.edgeSnapshots.filter(
          (s) => s.confidence === 'high' || s.confidence === 'very_high'
        ).length;
        console.log(JSON.stringify(wrapSuccess('watch', result, {
          scan_id: result.scanId,
          theme,
          events_scanned: result.eventsScanned,
          actionable,
          octagon_credits_used: result.octagonCreditsUsed,
        })));
      } else {
        console.clear();
        console.log(`Watch cycle #${totalCycles} — theme "${theme}" — every ${intervalMinutes}m\n`);
        console.log(formatScanTable(result));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.json) {
        console.log(JSON.stringify(wrapError('watch', 'SCAN_ERROR', message)));
      } else {
        console.error(`[watch] Scan error: ${message}`);
      }
    }
  };

  // Run first cycle immediately
  await runCycle();

  // Continue running on interval until stopped
  timer = setInterval(() => {
    if (stopped) return;
    runCycle().catch((err) => {
      console.error(`[watch] Scan cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);

  // Keep process alive — the SIGINT handler will exit
  await new Promise<void>(() => {});
}

// ─── Per-ticker watch mode ──────────────────────────────────────────────────

interface TickerSnapshot {
  ticker: string;
  lastPrice: string;
  yesAsk: string;
  yesBid: string;
  noAsk: string;
  noBid: string;
  spread: string;
  volume: string;
  openInterest: string;
  orderbook: { price: string; quantity: number }[];
  timestamp: string;
}

/** Format a decimal price (0-1) as a USDC amount per share. */
function fmtDollars(val: number): string {
  return `$${val.toFixed(3)}`;
}

function fmtNum(n: number | string | undefined | null): string {
  if (n === undefined || n === null) return '-';
  const val = typeof n === 'number' ? n : parseFloat(n as string);
  if (isNaN(val)) return '-';
  return val.toLocaleString();
}

async function fetchTickerSnapshot(ticker: string): Promise<TickerSnapshot> {
  const m = await lookupMarket(ticker);
  if (!m) throw new Error(`Market '${ticker}' not found on Polymarket.`);

  // Gamma's bestBid/bestAsk are cached and lag the live book, so prefer the CLOB
  // book for quotes and fall back to Gamma only if the book is empty.
  let yesBid = m.yes_bid;
  let yesAsk = m.yes_ask;
  let orderbook: { price: string; quantity: number }[] = [];

  try {
    const book = await fetchMarketOrderbook(m);
    if (book) {
      if (book.bids[0]) yesBid = book.bids[0].price;
      if (book.asks[0]) yesAsk = book.asks[0].price;
      orderbook = book.bids.slice(0, 5).map((l) => ({
        price: fmtDollars(l.price),
        quantity: l.size,
      }));
    }
  } catch {
    // Book not available for every market — fall back to Gamma quotes
  }

  const noBid = yesAsk > 0 ? 1 - yesAsk : 0;
  const noAsk = yesBid > 0 ? 1 - yesBid : 0;
  const spread = yesAsk - yesBid;

  return {
    ticker: m.ticker,
    lastPrice: Number.isFinite(m.last_price) ? fmtDollars(m.last_price) : '-',
    yesAsk: fmtDollars(yesAsk),
    yesBid: fmtDollars(yesBid),
    noAsk: fmtDollars(noAsk),
    noBid: fmtDollars(noBid),
    spread: `$${spread.toFixed(4)}`,
    volume: fmtNum(m.volume),
    openInterest: fmtNum(m.open_interest),
    orderbook,
    timestamp: new Date().toISOString(),
  };
}

function formatTickerDashboard(snap: TickerSnapshot, tick: number): string {
  const lines: string[] = [];
  lines.push(`  ${snap.ticker}  (tick #${tick})  ${new Date(snap.timestamp).toLocaleTimeString()}`);
  lines.push('');
  lines.push(`  Last Price:     ${snap.lastPrice}`);
  lines.push(`  YES Bid / Ask:  ${snap.yesBid} / ${snap.yesAsk}   Spread: ${snap.spread}`);
  lines.push(`  NO  Bid / Ask:  ${snap.noBid} / ${snap.noAsk}`);
  lines.push(`  Volume:         ${snap.volume}   Open Interest: ${snap.openInterest}`);

  if (snap.orderbook.length > 0) {
    lines.push('');
    lines.push('  Order book (top 5 bids):');
    for (const level of snap.orderbook) {
      lines.push(`    ${level.price}  ×${level.quantity}`);
    }
  }

  return lines.join('\n');
}

export async function handleWatchTicker(ticker: string, args: ParsedArgs): Promise<void> {
  let totalTicks = 0;
  const startTime = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval>;

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(0);
    if (args.json) {
      console.log(JSON.stringify({
        event: 'watch_stopped',
        ticker,
        totalTicks,
        durationSeconds: Number(durationSec),
      }));
    } else {
      console.log('');
      console.log(`Watch stopped. ${totalTicks} ticks in ${durationSec}s`);
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const rawTickerInterval = Number(getBotSetting('watch.ticker_interval_seconds'));
  const tickerIntervalMs = (Number.isFinite(rawTickerInterval) && rawTickerInterval > 0 ? rawTickerInterval : 5) * 1000;
  const intervalMs = args.interval ? args.interval * 1000 : tickerIntervalMs;
  const intervalLabel = intervalMs >= 60_000 ? `${(intervalMs / 60_000).toFixed(0)}m` : `${(intervalMs / 1000).toFixed(0)}s`;

  if (!args.json) {
    console.log(`Watching ${ticker} every ${intervalLabel} (Ctrl+C to stop)\n`);
  }

  const runTick = async (): Promise<void> => {
    try {
      const snap = await fetchTickerSnapshot(ticker);
      totalTicks++;

      if (args.json) {
        console.log(JSON.stringify(wrapSuccess('watch:ticker', snap)));
      } else {
        console.clear();
        console.log(formatTickerDashboard(snap, totalTicks));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.json) {
        console.log(JSON.stringify(wrapError('watch:ticker', 'FETCH_ERROR', message)));
      } else {
        console.error(`[watch] Error: ${message}`);
      }
    }
  };

  // First tick immediately
  await runTick();

  // Continue on interval
  timer = setInterval(() => {
    if (stopped) return;
    runTick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[watch-ticker] Tick failed: ${message}`);
    });
  }, intervalMs);

  // Keep process alive
  await new Promise<void>(() => {});
}
