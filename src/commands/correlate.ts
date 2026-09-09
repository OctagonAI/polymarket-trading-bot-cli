import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import type { ParsedArgs } from './parse-args.js';
import { getCorrelations, type CorrelationResponseWithSides } from '../scan/octagon-api.js';
import { formatTable } from './scan-formatters.js';

function shortTicker(t: string, max = 18): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function collectTickers(args: ParsedArgs): string[] {
  const set = new Set<string>();
  for (const p of args.positionalArgs) {
    const upper = p.toUpperCase();
    if (upper) set.add(upper);
  }
  if (args.tickers) {
    for (const t of args.tickers.split(',')) {
      const upper = t.trim().toUpperCase();
      if (upper) set.add(upper);
    }
  }
  return Array.from(set);
}

export async function handleCorrelate(args: ParsedArgs): Promise<CLIResponse<CorrelationResponseWithSides>> {
  const tickers = collectTickers(args);
  if (tickers.length < 2) {
    return wrapError(
      'correlate',
      'TOO_FEW_TICKERS',
      'Usage: correlate <ticker1> <ticker2> [...] [--window-days N] [--sides yes,no,yes] [--cells]',
    );
  }
  if (tickers.length > 100) {
    return wrapError('correlate', 'TOO_MANY_TICKERS', 'At most 100 tickers allowed.');
  }

  // --sides yes,no,yes — must match ticker count (server enforces this too)
  let sides: ('yes' | 'no')[] | undefined;
  if (args.sides) {
    sides = args.sides.split(',').map((s) => (s.trim().toLowerCase() === 'no' ? 'no' : 'yes'));
    if (sides.length !== tickers.length) {
      return wrapError('correlate', 'SIDES_MISMATCH',
        `--sides has ${sides.length} entries but ${tickers.length} tickers were supplied.`);
    }
  }

  try {
    const data = await getCorrelations({
      market_tickers: tickers,
      sides,
      include_cell_detail: args.cells || undefined,
      window_days: args.windowDays,
      interval: args.correlationInterval,
    });
    return wrapSuccess('correlate', data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapError('correlate', 'OCTAGON_ERROR', message);
  }
}

export function formatCorrelationHuman(data: CorrelationResponseWithSides): string {
  const lines: string[] = [];
  const sidesLabel = data.sides ? ` (sides: ${data.sides.join(',')})` : '';
  lines.push(`Correlation matrix — ${data.tickers.length} markets${sidesLabel}, ${data.window_days}d window, interval ${data.interval}`);
  if (data.missing.length > 0) {
    lines.push(`  Dropped (no candle data): ${data.missing.join(', ')}`);
  }
  lines.push('');

  if (data.tickers.length === 0) {
    lines.push('No matrix available — all tickers were missing candle data.');
    return lines.join('\n');
  }

  // Matrix table — header row of short tickers, body of correlation values.
  const headerRow: string[][] = [['', ...data.tickers.map((t) => shortTicker(t, 14))]];
  const bodyRows: string[][] = data.matrix.map((row, i) => [
    shortTicker(data.tickers[i] ?? '?', 14),
    ...row.map((v) => (v == null ? '-' : v.toFixed(2))),
  ]);
  lines.push(formatTable(headerRow[0], bodyRows));

  if (data.ranked_pairs.length > 0) {
    lines.push('');
    lines.push('Most-uncorrelated pairs (ascending):');
    const topN = data.ranked_pairs.slice(0, 10);
    const rows: string[][] = topN.map((p) => [
      shortTicker(p.ticker_a, 22),
      shortTicker(p.ticker_b, 22),
      p.correlation.toFixed(3),
    ]);
    lines.push(formatTable(['Ticker A', 'Ticker B', 'Corr'], rows));
  }

  if (data.cells_detail && data.cells_detail.length > 0) {
    lines.push('');
    lines.push('Cell detail:');
    const rows: string[][] = data.cells_detail.map((c) => [
      shortTicker(c.ticker_a, 20),
      shortTicker(c.ticker_b, 20),
      c.correlation == null ? '-' : c.correlation.toFixed(3),
      String(c.overlap_count),
      c.reason,
    ]);
    lines.push(formatTable(['Ticker A', 'Ticker B', 'Corr', 'Overlap', 'Reason'], rows));
  }

  return lines.join('\n');
}
