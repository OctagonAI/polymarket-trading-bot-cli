import type { PolymarketMarket, PolymarketPosition } from '../tools/polymarket/types.js';

// ─── Box header helper ───────────────────────────────────────────────────────

const BOX_WIDTH = 40;

export function formatBoxHeader(title: string): string[] {
  const inner = BOX_WIDTH - 2; // space between ║ walls
  const safeTitle = title.length > inner ? title.slice(0, inner - 1) + '…' : title;
  const pad = inner - safeTitle.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return [
    '',
    '╔' + '═'.repeat(inner) + '╗',
    '║' + ' '.repeat(left) + safeTitle + ' '.repeat(right) + '║',
    '╚' + '═'.repeat(inner) + '╝',
  ];
}

/** Actual Kalshi /portfolio/balance response shape */
/**
 * Polymarket has no Kalshi-style balance endpoint: free USDC lives on-chain and
 * is not exposed by the Data API, so only position value is reported.
 */
export interface PolymarketBalanceResponse {
  portfolio_value: number;
  address?: string;
}

// ─── Value parsers ────────────────────────────────────────────────────────────
// Polymarket prices are decimal probabilities in [0,1] (USDC per share). There
// is no cents/dollars dual encoding to reconcile — the Kalshi client needed that,
// this one does not.

function parseDollars(val: string | number | undefined | null): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = typeof val === 'number' ? val : parseFloat(val as string);
  return isNaN(n) ? undefined : n;
}

function parsePosition(val: string | number | undefined | null): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = typeof val === 'number' ? val : parseFloat(val as string);
  return isNaN(n) ? undefined : n;
}

/** Format a dollar amount (already in dollars, not cents) */
function fmtDollars(val: string | number | undefined | null): string {
  const n = parseDollars(val);
  if (n === undefined) return '-';
  return `$${n.toFixed(2)}`;
}

/**
 * Format a decimal price (0-1) the way Polymarket displays it: cents, with a
 * decimal only when the market's sub-cent tick actually uses one.
 */
export function fmtPrice(val: number | string | undefined | null): string {
  const n = parseDollars(val);
  if (n === undefined) return '-';
  const cents = n * 100;
  return Number.isInteger(Math.round(cents * 10) / 10) && Math.abs(cents - Math.round(cents)) < 1e-9
    ? `${Math.round(cents)}\u00A2`
    : `${cents.toFixed(1)}\u00A2`;
}

/** Format a USDC amount. */
export function fmtUsd(val: number | undefined | null): string {
  if (val === undefined || val === null || !Number.isFinite(val)) return '-';
  return `$${val.toFixed(2)}`;
}

/** Format a number with commas, safely handling null/undefined */
function fmtNum(n: number | string | undefined | null): string {
  if (n === undefined || n === null) return '-';
  const val = typeof n === 'number' ? n : parseFloat(n as string);
  if (isNaN(val)) return '-';
  if (val === 0) return '0';
  return val.toLocaleString();
}

/** Format ISO date string as short date */
function fmtDate(iso: string | undefined): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─── Access helpers (handle both _dollars and raw field names) ────────────────

function mktYesAsk(m: any): number | undefined { return m.yes_ask; }
function mktNoAsk(m: any): number | undefined { return m.no_ask; }
function mktYesBid(m: any): number | undefined { return m.yes_bid; }
function mktNoBid(m: any): number | undefined { return m.no_bid; }
function mktLastPrice(m: any): number | undefined { return m.last_price; }
function mktVolume(m: any): number | undefined { return m.volume; }
function mktOpenInterest(m: any): number | undefined { return m.open_interest; }

// ─── Formatters ───────────────────────────────────────────────────────────────

export function formatBalance(data: PolymarketBalanceResponse): string {
  const lines: string[] = [];
  lines.push('**Portfolio Value**');
  lines.push('');
  lines.push(`Position Value:  ${fmtUsd(data.portfolio_value)}`);
  if (data.address) lines.push(`Wallet:          ${data.address}`);
  lines.push('');
  lines.push('Free USDC balance is held on-chain and is not reported here.');
  return lines.join('\n');
}

export function formatPositions(positions: any[]): string {
  if (!positions.length) return 'No open positions.';

  const rows = positions.map((p) => [
    p.ticker,
    p.outcome ?? '-',
    fmtNum(p.size),
    fmtPrice(p.avg_price),
    fmtPrice(p.cur_price),
    fmtUsd(p.current_value),
    fmtUsd(p.cash_pnl),
  ]);

  return formatTable(['Market', 'Outcome', 'Shares', 'Avg', 'Now', 'Value', 'P&L'], rows);
}

export function formatMarkets(markets: any[]): string {
  if (!markets.length) return 'No markets found.';

  const rows = markets.map((m) => [
    m.ticker,
    truncate(m.title ?? '', 40),
    fmtPrice(mktYesAsk(m)),
    fmtPrice(mktNoAsk(m)),
    fmtNum(mktVolume(m)),
    fmtDate(m.close_time),
  ]);

  return formatTable(
    ['Ticker', 'Title', 'YES Ask', 'NO Ask', 'Volume', 'Closes'],
    rows
  );
}

export function formatMarketDetail(market: any): string {
  const lines: string[] = [];
  lines.push(`**${market.ticker}**`);
  if (market.title) lines.push(market.title);
  if (market.subtitle) lines.push(market.subtitle);
  lines.push('');
  lines.push(`Status:     ${market.status ?? '-'}`);
  lines.push(`YES Bid:    ${fmtPrice(mktYesBid(market))}   YES Ask: ${fmtPrice(mktYesAsk(market))}`);
  lines.push(`NO Bid:     ${fmtPrice(mktNoBid(market))}   NO Ask:  ${fmtPrice(mktNoAsk(market))}`);
  lines.push(`Last Price: ${fmtPrice(mktLastPrice(market))}`);
  lines.push(`Volume:     ${fmtNum(mktVolume(market))}   Open Interest: ${fmtNum(mktOpenInterest(market))}`);
  lines.push(`Closes:     ${fmtDate(market.close_time)}`);
  if (market.result) lines.push(`Result:     ${market.result}`);
  return lines.join('\n');
}

export function formatExchangeStatus(data: Record<string, unknown>): string {
  const active = data.exchange_active ? '✓ Exchange Active' : '✗ Exchange Inactive';
  const trading = data.trading_active ? '✓ Trading Active' : '✗ Trading Paused';
  return `${active}\n${trading}`;
}

export function formatEvents(events: any[]): string {
  if (!events.length) return 'No events found.';

  const rows = events.map((e) => {
    const markets = e.markets ?? [];
    const marketCount = markets.length > 0 ? String(markets.length) : '-';

    // Find the leading outcome (highest YES price) for the top outcome column
    let topOutcome = '-';
    let topPct = '-';
    if (markets.length > 0) {
      // For multi-market events, show the frontrunner
      // For binary events (1 market), show the YES probability
      const sorted = [...markets].sort((a: any, b: any) => {
        const volA = parseFloat(a.volume_fp ?? a.volume ?? '0') || 0;
        const volB = parseFloat(b.volume_fp ?? b.volume ?? '0') || 0;
        return volB - volA;
      });
      const top = sorted[0];
      // Handle both dollar strings ("0.1800") and integer cents (18)
      const rawAsk = top.yes_ask_dollars ?? top.yes_ask;
      let yesAsk = 0;
      if (rawAsk !== undefined && rawAsk !== null) {
        const n = parseFloat(String(rawAsk));
        yesAsk = !isNaN(n) ? (n > 1 ? n / 100 : n) : 0;
      }
      topOutcome = truncate(top.yes_sub_title || top.subtitle || top.ticker?.split('-').pop() || '', 25);
      if (yesAsk > 0) topPct = `${Math.round(yesAsk * 100)}%`;
    }

    return [
      e.event_ticker,
      truncate(e.title ?? '', 35),
      marketCount,
      topOutcome,
      topPct,
    ];
  });

  return formatTable(
    ['Ticker', 'Title', 'Mkts', 'Top Outcome', 'YES'],
    rows
  );
}

export function formatEventDetail(event: any): string {
  const lines: string[] = [];
  lines.push(`**${event.event_ticker}**`);
  if (event.title) lines.push(event.title);
  if (event.sub_title) lines.push(event.sub_title);
  lines.push('');
  lines.push(`Series:   ${event.series_ticker ?? '-'}`);
  lines.push(`Category: ${event.category ?? '-'}`);
  lines.push(`Strike:   ${fmtDate(event.strike_date)}`);
  if (event.mutually_exclusive !== undefined) {
    lines.push(`Mutually Exclusive: ${event.mutually_exclusive ? 'Yes' : 'No'}`);
  }

  const markets = event.markets ?? [];
  if (markets.length > 0) {
    lines.push('');
    lines.push(`**Markets (${markets.length})**`);
    const rows = markets.map((m: any) => [
      m.ticker,
      truncate(m.title ?? m.subtitle ?? '', 35),
      fmtPrice(mktYesAsk(m)),
      fmtPrice(mktNoAsk(m)),
      fmtNum(mktVolume(m)),
    ]);
    lines.push(formatTable(['Ticker', 'Title', 'YES Ask', 'NO Ask', 'Volume'], rows));
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = '─';

  const topBorder = '┌' + colWidths.map((w) => sep.repeat(w + 2)).join('┬') + '┐';
  const headerRow = '│' + headers.map((h, i) => ` ${pad(h, colWidths[i])} `).join('│') + '│';
  const midBorder = '├' + colWidths.map((w) => sep.repeat(w + 2)).join('┼') + '┤';
  const bottomBorder = '└' + colWidths.map((w) => sep.repeat(w + 2)).join('┴') + '┘';

  const dataRows = rows.map(
    (row) => '│' + colWidths.map((w, i) => ` ${pad(row[i] ?? '', w)} `).join('│') + '│'
  );

  return [topBorder, headerRow, midBorder, ...dataRows, bottomBorder].join('\n');
}
