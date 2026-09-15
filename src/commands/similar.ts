/**
 * Related-market lookup via Octagon's /predictions/markets/similar.
 *
 * NOT semantic search. Octagon dropped the embedding tables in August 2026;
 * there is no vector lookup behind this any more:
 *
 *   - anchor by ticker → a taxonomy walk. Markets in the anchor's own event
 *     first, then its series, then its category, each tier ordered by
 *     volume_24h desc. Structural relatedness, not meaning.
 *   - anchor by -q     → the same keyword ts_rank the market list uses.
 *
 * The API's `distance` field is a synthesized ordinal — literally
 * row_number() / 1000 — kept only because the response model requires a
 * non-null number. It is not a metric: it says nothing about how alike two
 * markets are, it is not comparable across responses, and a threshold like
 * `distance < 0.2` just means "the first 199 rows". The renderer therefore
 * shows the row's position and never the raw value.
 */
import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import type { ParsedArgs } from './parse-args.js';
import { findSimilarMarkets, stripVenuePrefix, type SimilarResponse, type SimilarMarketRow } from '../scan/octagon-api.js';
import { formatTable } from './scan-formatters.js';

/**
 * The venue-generic /markets/similar route returns a bare page, where the
 * Kalshi-era route echoed the anchor back. The anchor is re-attached here so the
 * rendered output and the --json shape are unchanged.
 */
export interface SimilarView extends SimilarResponse {
  anchor_ticker: string | null;
  anchor_query: string | null;
}

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

/**
 * Does this look like an identifier rather than a query?
 *
 * Exported because `search` uses it to decide whether to drill into an event
 * before searching. It cannot tell an EVENT slug from a MARKET slug — both are
 * lowercase and hyphenated, in one namespace — so callers must resolve the
 * identifier rather than trust the shape.
 */
export function looksLikeSlug(s: string): boolean {
  // Polymarket slugs are hyphenated, spaceless and alphanumeric
  // (`will-btc-hit-100k-by-dec-2026`). Anything containing a space is a query.
  return /^[A-Z0-9._-]+$/i.test(s) && /[A-Z]/i.test(s) && s.includes('-');
}

export async function handleSimilar(args: ParsedArgs): Promise<CLIResponse<SimilarView>> {
  const positional = args.positionalArgs.join(' ').trim();
  let anchorTicker = args.ticker;
  let q = args.query;

  if (!anchorTicker && !q && positional) {
    // Hyphenated single token → treat as a market slug, else as a query.
    if (looksLikeSlug(positional)) {
      anchorTicker = positional.toLowerCase();
    } else {
      q = positional;
    }
  }

  if (!anchorTicker && !q) {
    return wrapError('similar', 'MISSING_ANCHOR', 'Usage: similar <market-slug> | similar -q "query text" [--top-k N] [--category C] [--min-volume N] [--close-before ISO]');
  }
  if (anchorTicker && q) {
    return wrapError('similar', 'AMBIGUOUS_ANCHOR', 'Pass either a market slug or -q "query", not both.');
  }

  try {
    const data = await findSimilarMarkets({
      anchor_ticker: anchorTicker,
      q,
      top_k: args.topK,
      category: args.category,
      min_volume_24h: args.minVolume,
      close_before: args.closeBefore,
    });
    const view: SimilarView = { ...data, anchor_ticker: anchorTicker ?? null, anchor_query: q ?? null };
    return wrapSuccess('similar', view);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapError('similar', 'OCTAGON_ERROR', message);
  }
}

export function formatSimilarHuman(data: SimilarView): string {
  const lines: string[] = [];
  const anchorKind = data.anchor_ticker ? 'ticker' : 'query';
  const anchor = data.anchor_ticker
    ? data.anchor_ticker
    : data.anchor_query
      ? `"${data.anchor_query}"`
      : 'unknown anchor';
  lines.push(`Markets related to ${anchor} — ${data.data.length} result(s)`);
  lines.push('');

  if (data.data.length === 0) {
    lines.push('No similar markets found.');
    return lines.join('\n');
  }

  const rows: string[][] = data.data.map((m: SimilarMarketRow, i) => [
    // `distance` is row_number()/1000, so it carries no information the row's
    // own position doesn't. Render the position and drop the false precision.
    String(i + 1),
    truncate(m.native_ticker ?? stripVenuePrefix(m.market_ticker), 44),
    truncate(m.title ?? '-', 40),
    fmtMoney(m.last_price ?? m.yes_ask),
    fmtVol(m.volume_24h),
    m.category ?? '-',
  ]);

  lines.push(formatTable(
    ['#', 'Slug', 'Title', 'Last', '24h Vol', 'Category'],
    rows,
  ));
  lines.push('');
  lines.push(
    anchorKind === 'ticker'
      ? 'Ranked by relatedness, then 24h volume: same event first, then same series, then same category.'
      : 'Ranked by keyword relevance, then 24h volume.',
  );
  return lines.join('\n');
}
