import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import type { ParsedArgs } from './parse-args.js';
import {
  fetchOctagonEventsPage,
  resolveOctagonEvent,
  type OctagonEventEntry,
  type OctagonEventMarket,
} from '../scan/octagon-events-api.js';
import { formatTable } from './scan-formatters.js';
import { analysisPredatesCapture, formatAge, parseUtcTimestamp } from '../utils/time.js';
import { contractLabels } from '../utils/contract-labels.js';
import { fmtPrice } from './formatters.js';

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

/** "2026-09-23 17:53 UTC" */
function fmtUtcMinute(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * When the numbers were captured, e.g. "2026-09-23 17:53 UTC (7d ago)". The
 * event is a snapshot that can be weeks old, so this sits above every number.
 * Adds the analysis date when a refresh carried an older analysis forward.
 */
function snapshotLabel(e: OctagonEventEntry): string | null {
  const captured = parseUtcTimestamp(e.captured_at);
  if (!captured) return null;
  let label = `${fmtUtcMinute(captured)} (${formatAge(captured.getTime() / 1000)})`;
  if (analysisPredatesCapture(e.captured_at, e.analysis_last_updated)) {
    label += ` · analysis from ${parseUtcTimestamp(e.analysis_last_updated)!.toISOString().slice(0, 10)}`;
  }
  return label;
}

/** Compact capture age for the list, e.g. "3h", "7d". */
function capturedAge(e: OctagonEventEntry): string {
  const captured = parseUtcTimestamp(e.captured_at);
  return captured ? formatAge(captured.getTime() / 1000).replace(/ ago$/, '') : '-';
}

export type EventsResult =
  | { kind: 'list'; data: OctagonEventEntry[]; total_returned: number; filtered_from?: number }
  | { kind: 'detail'; event: OctagonEventEntry };

export async function handleEvents(args: ParsedArgs): Promise<CLIResponse<EventsResult>> {
  const positional = args.positionalArgs[0];

  try {
    // events <slug|event_ticker|url> — drill into one. Anything that is not the
    // bare `list` subcommand is an event key; the Kalshi-era check for a `KX`
    // prefix has no Polymarket analogue, since every key is a slug.
    if (positional && positional.toLowerCase() !== 'list') {
      const ev = await resolveOctagonEvent(positional);
      if (!ev) {
        return wrapError('events', 'EVENT_NOT_FOUND', `No event found for ${positional}`);
      }
      return wrapSuccess('events', { kind: 'detail', event: ev });
    }

    // events list — filter + sort
    const wantLimit = args.limit ?? 50;
    const all: OctagonEventEntry[] = [];
    let cursor: string | null = null;
    // Cap pages defensively (universe is ~hundreds; this is paranoid)
    for (let i = 0; i < 25; i++) {
      const page: { data: OctagonEventEntry[]; next_cursor: string | null; has_more: boolean } =
        await fetchOctagonEventsPage({ cursor });
      all.push(...page.data);
      if (!page.has_more) break;
      cursor = page.next_cursor;
      if (!cursor) break;
    }

    let filtered = all;
    if (args.category) {
      const cat = args.category.toLowerCase();
      filtered = filtered.filter((e) => (`${e.series_category ?? ''} ${e.meta_category ?? ''}`).toLowerCase().includes(cat));
    }
    if (args.minVolume !== undefined) {
      const floor = args.minVolume;
      filtered = filtered.filter((e) => (e.total_volume ?? 0) >= floor);
    }

    // Default sort: descending by total_volume
    filtered.sort((a, b) => (b.total_volume ?? 0) - (a.total_volume ?? 0));

    return wrapSuccess('events', {
      kind: 'list',
      data: filtered.slice(0, wantLimit),
      total_returned: Math.min(filtered.length, wantLimit),
      filtered_from: all.length !== filtered.length ? all.length : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapError('events', 'OCTAGON_ERROR', message);
  }
}

export function formatEventsHuman(result: EventsResult): string {
  if (result.kind === 'detail') return formatEventDetail(result.event);
  return formatEventList(result.data, result.filtered_from);
}

function formatEventList(events: OctagonEventEntry[], filteredFrom?: number): string {
  const lines: string[] = [];
  const fromLabel = filteredFrom != null ? ` (filtered from ${filteredFrom})` : '';
  lines.push(`Octagon events — ${events.length} shown${fromLabel}, sorted by total_volume desc`);
  lines.push('');
  if (events.length === 0) {
    lines.push('No events match.');
    return lines.join('\n');
  }
  const rows: string[][] = events.map((e) => [
    e.event_ticker,
    truncate(e.name ?? '', 40),
    e.series_category ?? '-',
    `${e.model_probability.toFixed(1)}%`,
    `${e.market_probability.toFixed(1)}%`,
    `${e.edge_pp >= 0 ? '+' : ''}${e.edge_pp.toFixed(1)}pp`,
    fmtVol(e.total_volume),
    (e.close_time ?? '').slice(0, 10),
    capturedAge(e),
  ]);
  lines.push(formatTable(
    ['Event', 'Name', 'Category', 'Model', 'Market', 'Edge', 'Volume', 'Closes', 'Captured'],
    rows,
  ));
  return lines.join('\n');
}

function formatEventDetail(e: OctagonEventEntry): string {
  const lines: string[] = [];
  lines.push(`Event ${e.event_ticker} — ${e.name}`);
  const snapshot = snapshotLabel(e);
  if (snapshot) lines.push(`  Snapshot   ${snapshot}`);
  lines.push(`  Category   ${e.series_category}`);
  lines.push(`  Model      ${e.model_probability.toFixed(1)}%`);
  lines.push(`  Market     ${e.market_probability.toFixed(1)}%`);
  lines.push(`  Edge       ${e.edge_pp >= 0 ? '+' : ''}${e.edge_pp.toFixed(1)}pp  (confidence ${e.confidence_score.toFixed(1)}/10)`);
  lines.push(`  Volume     ${fmtVol(e.total_volume)}  open interest ${fmtVol(e.total_open_interest)}`);
  lines.push(`  Closes     ${e.close_time ?? '-'}`);
  if (e.key_takeaway) {
    lines.push('');
    lines.push(`  ${e.key_takeaway}`);
  }
  if (e.markets?.length) {
    lines.push('');
    lines.push(...formatMarketLadder(e.markets, e.event_ticker));
    return lines.join('\n');
  }
  const outcomes = e.outcome_probabilities ?? [];
  if (outcomes.length > 0) {
    lines.push('');
    lines.push('Sub-markets (outcome probabilities):');
    const contracts = contractLabels(outcomes.map((o) => o.market_ticker), e.event_ticker);
    const rows: string[][] = outcomes.map((o, i) => {
      const edge = o.model_probability != null && o.market_probability != null
        ? o.model_probability - o.market_probability
        : null;
      return [
        truncate(contracts[i], 40),
        truncate(o.outcome_name ?? '-', 35),
        o.model_probability != null ? `${o.model_probability.toFixed(1)}%` : '-',
        o.market_probability != null ? `${o.market_probability.toFixed(1)}%` : '-',
        edge != null ? `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp` : '-',
        fmtVol(o.volume_24h ?? o.volume),
      ];
    });
    lines.push(formatTable(
      ['Market', 'Outcome', 'Model', 'Market', 'Edge', '24h Vol'],
      rows,
    ));
  }
  return lines.join('\n');
}

function fmtPct(v: number | null | undefined): string {
  return v != null ? `${v.toFixed(1)}%` : '-';
}

/**
 * The outcome ladder from markets[], which carries each market's quote and
 * status from the same run. A determined market's price is pinned at 0 or 100,
 * so it gets no edge and no quote: shown as one, a settled strike would read as
 * full model/market agreement.
 */
function formatMarketLadder(markets: OctagonEventMarket[], eventTicker: string): string[] {
  const showStatus = markets.some((m) => m.status !== 'active');
  const contracts = contractLabels(markets.map((m) => m.market_ticker), eventTicker);
  const rows: string[][] = markets.map((m, i) => {
    const determined = m.status === 'determined';
    const edge = !determined && m.model_probability != null && m.market_probability != null
      ? m.model_probability - m.market_probability
      : null;
    const quote = determined || (m.yes_bid == null && m.yes_ask == null)
      ? '-'
      : `${fmtPrice(m.yes_bid)} / ${fmtPrice(m.yes_ask)}`;
    const row = [
      truncate(contracts[i], 40),
      truncate(m.outcome_name ?? '-', 35),
      fmtPct(m.model_probability),
      fmtPct(m.market_probability),
      edge != null ? `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pp` : '-',
      quote,
      fmtVol(m.volume_24h ?? m.volume),
    ];
    if (showStatus) row.push(m.status);
    return row;
  });
  const headers = ['Market', 'Outcome', 'Model', 'Market', 'Edge', 'Bid / Ask', '24h Vol'];
  if (showStatus) headers.push('Status');
  return ['Sub-markets:', formatTable(headers, rows)];
}
