/**
 * `catalysts upcoming [--days N]` — list active markets sorted by close_time
 * within the next N days. Group by week so the user can scan an event-calendar
 * view.
 *
 * Pure composition over the market search endpoint — no new endpoint needed.
 */
import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import type { ParsedArgs } from './parse-args.js';
import { searchOctagonMarkets, type KalshiMarketRow } from '../scan/octagon-api.js';
import { formatTable } from './scan-formatters.js';

const UNIVERSE_PAGE_LIMIT = 200;
const MAX_PAGES = 25; // safety cap; universe is small

/**
 * Walk the open market universe, one page at a time.
 *
 * Moved here from the series command, which was this function's original home
 * and its only other caller.
 */
async function fetchUniverse(opts: {
  q?: string;
  category?: string;
  series_ticker?: string;
  min_volume_24h?: number;
  close_before?: string;
  maxMarkets?: number;
}): Promise<KalshiMarketRow[]> {
  const all: KalshiMarketRow[] = [];
  let cursor: string | undefined;
  const cap = opts.maxMarkets ?? 5000;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await searchOctagonMarkets({
      q: opts.q,
      category: opts.category,
      series_ticker: opts.series_ticker,
      min_volume_24h: opts.min_volume_24h,
      close_before: opts.close_before,
      limit: UNIVERSE_PAGE_LIMIT,
      cursor,
    });
    all.push(...page.data);
    if (all.length >= cap || !page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return all;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

function isoWeek(d: Date): string {
  // Return YYYY-MM-DD of the Monday of the ISO week.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay() || 7;
  if (day !== 1) tmp.setUTCDate(tmp.getUTCDate() - (day - 1));
  return tmp.toISOString().slice(0, 10);
}

export interface CatalystRow {
  market_ticker: string;
  series_prefix: string;
  title: string;
  category: string | null;
  close_time: string;
  volume_24h: number | null;
}

export interface CatalystsResult {
  days: number;
  weeks: Array<{ week_starting: string; markets: CatalystRow[] }>;
  total: number;
}

export async function handleCatalysts(args: ParsedArgs): Promise<CLIResponse<CatalystsResult>> {
  const sub = args.positionalArgs[0]?.toLowerCase() ?? 'upcoming';
  if (sub !== 'upcoming') {
    return wrapError('catalysts', 'UNKNOWN_SUB', `Unknown subcommand "${sub}". Try: catalysts upcoming [--days N]`);
  }
  const days = args.days ?? 30;
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 86_400_000);

  try {
    const universe = await fetchUniverse({
      close_before: cutoff.toISOString(),
      min_volume_24h: args.minVolume,
      category: args.category,
    });
    // Filter to markets that close in the future window
    const candidates = universe
      .filter((m) => m.close_time && new Date(m.close_time) > now)
      .map<CatalystRow>((m) => ({
        market_ticker: m.market_ticker,
        series_prefix: m.market_ticker.split('-')[0],
        title: m.title,
        category: m.category ?? null,
        close_time: m.close_time as string,
        volume_24h: m.volume_24h ?? null,
      }))
      .sort((a, b) => a.close_time.localeCompare(b.close_time));

    // Group by ISO week of close_time
    const buckets = new Map<string, CatalystRow[]>();
    for (const c of candidates) {
      const week = isoWeek(new Date(c.close_time));
      const arr = buckets.get(week) ?? [];
      arr.push(c);
      buckets.set(week, arr);
    }
    const limit = args.limit ?? 8;
    const weeks = Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week_starting, markets]) => ({
        week_starting,
        markets: markets
          .sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0))
          .slice(0, limit),
      }));
    return wrapSuccess('catalysts', { days, weeks, total: candidates.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapError('catalysts', 'OCTAGON_ERROR', message);
  }
}

export function formatCatalystsHuman(result: CatalystsResult): string {
  const lines: string[] = [];
  lines.push(`Upcoming catalysts — next ${result.days} days, ${result.total} markets across ${result.weeks.length} weeks`);
  lines.push('');
  if (result.weeks.length === 0) {
    lines.push('No markets closing in that window.');
    return lines.join('\n');
  }
  for (const w of result.weeks) {
    lines.push(`Week of ${w.week_starting} — ${w.markets.length} markets`);
    const rows: string[][] = w.markets.map((m) => [
      m.market_ticker,
      truncate(m.title, 45),
      m.close_time.slice(0, 16).replace('T', ' '),
      fmtVol(m.volume_24h),
      m.category ?? '-',
    ]);
    lines.push(formatTable(['Market', 'Title', 'Closes (UTC)', '24h Vol', 'Category'], rows));
    lines.push('');
  }
  return lines.join('\n');
}
