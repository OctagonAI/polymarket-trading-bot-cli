/**
 * Octagon-powered search formatters that back the extended /search and
 * /search edge code paths. Used by dispatch.ts and index.ts when
 * OCTAGON_API_KEY is set; the legacy local-SQLite paths remain as fallback.
 */
import { formatTable } from './scan-formatters.js';
import {
  stripVenuePrefix,
  type OctagonMarketRow,
  type OctagonEventSearchRow,
  type PagedResult,
  type MarketsWithEdgeResponse,
} from '../scan/octagon-api.js';

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  return `$${v.toFixed(2)}`;
}

function fmtVol(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

function fmtCloseDate(iso: string | null): string {
  if (!iso) return '-';
  // Slicing blind renders a malformed value as garbage in the column. Validate
  // first, matching the guard formatMarketsWithEdgeHuman already uses below —
  // but still slice the original rather than re-serialising, because
  // toISOString() would shift the displayed day for any offset-bearing
  // timestamp.
  if (Number.isNaN(new Date(iso).getTime())) return '-';
  return iso.slice(0, 10);
}

export function formatMarketSearchHuman(query: string, page: PagedResult<OctagonMarketRow>): string {
  const lines: string[] = [];
  const more = page.has_more ? ' (more available)' : '';
  lines.push(`Markets matching "${query}" — ${page.data.length} shown${more}`);
  lines.push('');

  if (page.data.length === 0) {
    lines.push('No markets found.');
    return lines.join('\n');
  }

  const rows: string[][] = page.data.map((m) => [
    truncate(m.native_ticker ?? stripVenuePrefix(m.market_ticker), 44),
    truncate(m.title ?? '-', 40),
    fmtMoney(m.last_price ?? m.yes_ask),
    fmtVol(m.volume_24h),
    m.category ?? '-',
    fmtCloseDate(m.close_time),
  ]);
  lines.push(formatTable(['Slug', 'Title', 'Last', '24h Vol', 'Category', 'Closes'], rows));
  return lines.join('\n');
}

/**
 * Event-level search results.
 *
 * No Closes column: `/markets/events/search` returns `close_time: null` on
 * every row. The markets path still shows it.
 *
 * `describe` names what was searched ("theme politics", `"bitcoin"`) so an
 * empty result can say which one came back empty rather than printing a bare
 * table — silently-empty output is the failure mode this whole path fixes.
 */
export function formatEventSearchHuman(
  describe: string,
  page: PagedResult<OctagonEventSearchRow>,
): string {
  const lines: string[] = [];
  const more = page.has_more ? ' (more available)' : '';
  lines.push(`Events matching ${describe} — ${page.data.length} shown${more}`);
  lines.push('');

  if (page.data.length === 0) {
    lines.push(`No events found for ${describe}.`);
    return lines.join('\n');
  }

  const rows: string[][] = page.data.map((e) => [
    truncate(e.native_event_ticker ?? stripVenuePrefix(e.event_ticker), 46),
    truncate(e.title ?? '-', 44),
    fmtMoney(e.last_price ?? e.yes_ask),
    fmtVol(e.volume_24h),
    e.category ?? '-',
  ]);
  lines.push(formatTable(['Slug', 'Event', 'Last', '24h Vol', 'Category'], rows));
  const first = page.data[0];
  if (first) {
    const slug = first.native_event_ticker ?? stripVenuePrefix(first.event_ticker);
    lines.push('');
    lines.push(`Drill into one event: search ${slug}`);
  }
  return lines.join('\n');
}

export function formatMarketsWithEdgeHuman(data: MarketsWithEdgeResponse, minEdgePp: number): string {
  const lines: string[] = [];
  // Guard against invalid date strings — new Date('garbage').toISOString() throws RangeError.
  let captured = 'unknown';
  if (data.captured_at) {
    const d = new Date(data.captured_at);
    if (!Number.isNaN(d.getTime())) {
      captured = d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
  const run = data.run_id ? `run ${data.run_id.slice(0, 8)}, ` : '';
  lines.push(`Octagon Edge Scanner — ${run}captured ${captured} UTC, sort by ${data.sort_by}`);
  lines.push('════════════════════════════════════════════════════════');
  lines.push('');

  if (data.data.length === 0) {
    lines.push(`  No events with |edge| ≥ ${minEdgePp}pp found.`);
    return lines.join('\n');
  }

  const rows: string[][] = data.data.map((r, i) => [
    String(i + 1),
    truncate(stripVenuePrefix(r.market_ticker || r.event_ticker), 40),
    truncate(r.title, 35),
    `${r.model_probability.toFixed(1)}%`,
    `${r.market_probability.toFixed(1)}%`,
    `${r.edge_pp >= 0 ? '+' : ''}${r.edge_pp.toFixed(1)}pp`,
    `${(r.expected_return * 100).toFixed(1)}%`,
    fmtVol(r.total_volume),
    r.series_category ?? '-',
  ]);
  lines.push(formatTable(
    ['#', 'Ticker', 'Title', 'Model', 'Market', 'Edge', 'Exp Ret', 'Volume', 'Category'],
    rows,
  ));
  lines.push('');
  lines.push(`${data.data.length} event(s) returned${data.has_more ? ' (more available)' : ''}.`);
  return lines.join('\n');
}
