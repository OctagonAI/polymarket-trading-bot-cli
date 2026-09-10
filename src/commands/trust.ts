/**
 * Trader Trust scorecard.
 *
 * Surfaces Octagon's per-market market-integrity score from the
 * `trader_trust_json` field on /v1/predictions/events/{event_ticker}.
 *
 * Two views:
 *   - polymarket trust <event-slug>                   → table across all markets
 *   - polymarket trust <event-slug> --market <slug>   → single-market detail card
 *
 * Shape follows Octagon's `trader_dashboard_lean` calculation (v1.14 at time of
 * writing), which replaced the earlier six-score card. Four per-market scores
 * remain, all in [0, 100] and all HIGHER IS BETTER, so there is no longer a
 * mixed direction-of-good to colour around:
 *
 *     - market_quality       (overall composite)
 *     - liquidity
 *     - move_quality
 *     - resolution_clarity
 *
 * Any score can be null — `not_applicable` for markets the calculation skips
 * (no recent move, no book), or `suppressed` when the inputs are too thin to
 * publish. Nulls render as "—" rather than as a zero, which would read as a
 * damning score rather than an absent one.
 *
 * The event-level roll-up now lives in `event.event_quality` and `scope`; there
 * is no `rollup` object.
 *
 * trader_trust_json is null on reports generated before this calculation
 * shipped; the handler returns a clear "no scorecard yet" error rather than
 * crashing.
 */
import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import type { ParsedArgs } from './parse-args.js';
import { resolveOctagonEvent, normalizeEventKey } from '../scan/octagon-events-api.js';
import { formatTable } from './scan-formatters.js';
import { theme } from '../theme.js';

/** A raw metric backing the score; shown with --verbose. */
export interface TrustEvidence {
  text?: string;
  metric?: string;
  value?: unknown;
  window?: string;
}

export interface TrustScore {
  /** 0-100, or null when not_applicable/suppressed. */
  value: number | null;
  label: string;
  /** Plain-language reasons, pre-rendered by Octagon. */
  drivers?: string[];
  evidence?: TrustEvidence[];
  confidence?: 'low' | 'medium' | 'high';
  suppressed?: boolean;
  not_applicable?: boolean;
}

export interface TrustMarket {
  market_ticker: string;
  title: string;
  is_primary: boolean;
  lifecycle_status?: string;
  fair_cents?: number | null;
  best_bid_cents?: number | null;
  best_ask_cents?: number | null;
  spread_cents?: number | null;
  scores: {
    market_quality: TrustScore;
    liquidity: TrustScore;
    move_quality: TrustScore;
    resolution_clarity: TrustScore;
  };
}

export interface TraderTrustCard {
  calculation_version: string;
  computed_at: string;
  event_ticker: string;
  venue?: string;
  event?: {
    event_quality?: { value: number | null; label?: string; confidence?: string };
    structure?: string;
    coverage?: number | null;
  };
  scope?: {
    total_markets?: number;
    scored_markets?: number;
  };
  markets: TrustMarket[];
}

/** Color a 0-100 score. Every score in this card is higher-is-better. */
function colorScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return theme.muted('  —');
  const str = value.toFixed(0).padStart(3);
  if (value >= 70) return theme.success(str);
  if (value >= 40) return theme.warning(str);
  return theme.error(str);
}

/** Output shape for both table and detail views (machine-readable). */
export type TrustResult =
  | { kind: 'table'; card: TraderTrustCard; event_name: string | null }
  | { kind: 'detail'; card: TraderTrustCard; market: TrustMarket; verbose: boolean };

export async function handleTrust(args: ParsedArgs): Promise<CLIResponse<TrustResult>> {
  const raw = args.positionalArgs[0];
  if (!raw) {
    return wrapError('trust', 'MISSING_EVENT', 'Usage: trust <event-slug> [--market <market-slug>] [--verbose]');
  }
  const eventTicker = normalizeEventKey(raw);

  let event;
  try {
    event = await resolveOctagonEvent(eventTicker);
  } catch (err) {
    return wrapError('trust', 'OCTAGON_ERROR', err instanceof Error ? err.message : String(err));
  }
  if (!event) {
    return wrapError('trust', 'EVENT_NOT_FOUND', `No Octagon record for event ${eventTicker}.`);
  }
  if (!event.trader_trust_json) {
    return wrapError(
      'trust',
      'NO_SCORECARD',
      `No trust scorecard for ${eventTicker} yet. The Trader Trust calculation may not have run for this event — try again after the next Octagon refresh.`,
    );
  }

  let card: TraderTrustCard;
  try {
    card = JSON.parse(event.trader_trust_json) as TraderTrustCard;
  } catch (err) {
    return wrapError(
      'trust',
      'PARSE_ERROR',
      `Octagon returned malformed trader_trust_json for ${eventTicker}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(card.markets) || card.markets.length === 0) {
    return wrapError('trust', 'EMPTY_SCORECARD', `Trust scorecard for ${eventTicker} has no markets.`);
  }

  // Single-market detail view
  if (args.market) {
    const wanted = normalizeEventKey(args.market);
    const market = card.markets.find((m) => normalizeEventKey(m.market_ticker) === wanted);
    if (!market) {
      return wrapError(
        'trust',
        'MARKET_NOT_IN_SCORECARD',
        `Market ${wanted} is not in the trust scorecard for ${eventTicker}. Run \`trust ${eventTicker}\` to see the available markets.`,
      );
    }
    return wrapSuccess('trust', { kind: 'detail', card, market, verbose: args.verbose });
  }

  return wrapSuccess('trust', { kind: 'table', card, event_name: event.name ?? null });
}

export function formatTrustHuman(result: TrustResult): string {
  if (result.kind === 'table') return formatTrustTable(result.card, result.event_name);
  return formatTrustDetail(result.card, result.market, result.verbose);
}

const SCORE_KEYS: Array<keyof TrustMarket['scores']> = [
  'market_quality',
  'liquidity',
  'move_quality',
  'resolution_clarity',
];

const SCORE_HEADER_LABELS: Record<keyof TrustMarket['scores'], string> = {
  market_quality: 'Quality',
  liquidity: 'Liquidity',
  move_quality: 'Move',
  resolution_clarity: 'Resol.',
};

/** Cent prices come straight from Octagon; Polymarket's own unit is 0-1 USDC. */
function fmtCents(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : `${v.toFixed(0)}¢`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatTrustTable(card: TraderTrustCard, eventName: string | null): string {
  const lines: string[] = [];
  const title = eventName ? ` — ${eventName}` : '';
  lines.push(`Trader Trust scorecard for ${card.event_ticker}${title}`);
  const eq = card.event?.event_quality;
  if (eq) {
    const scored = card.scope?.scored_markets;
    const total = card.scope?.total_markets;
    const counts = scored !== undefined && total !== undefined ? `  ·  ${scored}/${total} markets scored` : '';
    lines.push(`  Event quality ${colorScore(eq.value)}/100  ${theme.muted(eq.label ?? '')}${counts}`);
  }
  lines.push(`  Calculation ${card.calculation_version}  ·  Computed ${card.computed_at.slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');

  // Sort by liquidity desc; the most active markets surface first. Unscored
  // markets sort last rather than as zeroes.
  const sorted = card.markets.slice().sort(
    (a, b) => (b.scores.liquidity?.value ?? -1) - (a.scores.liquidity?.value ?? -1),
  );

  const headers = ['', 'Market', 'Title', ...SCORE_KEYS.map((k) => SCORE_HEADER_LABELS[k]), 'Fair', 'Spread'];
  const rows: string[][] = sorted.map((m) => [
    m.is_primary ? '*' : ' ',
    truncate(m.market_ticker, 40),
    truncate(m.title, 30),
    ...SCORE_KEYS.map((k) => colorScore(m.scores[k]?.value)),
    fmtCents(m.fair_cents),
    fmtCents(m.spread_cents),
  ]);
  lines.push(formatTable(headers, rows));
  lines.push('');
  lines.push(theme.muted('  * = primary outcome.  Higher is better for every score;  — = not scored for this market.'));
  lines.push(theme.muted(`  Drill into one market: trust ${card.event_ticker} --market <market-slug> [--verbose]`));
  return lines.join('\n');
}

function formatTrustDetail(card: TraderTrustCard, market: TrustMarket, verbose: boolean): string {
  const lines: string[] = [];
  const primaryMark = market.is_primary ? ' (primary)' : '';
  lines.push(`Trader Trust — ${market.market_ticker}${primaryMark}`);
  lines.push(`  ${market.title}`);
  lines.push(`  Event ${card.event_ticker}  ·  Calculation ${card.calculation_version}  ·  Computed ${card.computed_at.slice(0, 16).replace('T', ' ')} UTC`);
  const quote = [
    market.best_bid_cents !== undefined || market.best_ask_cents !== undefined
      ? `Bid ${fmtCents(market.best_bid_cents)} / Ask ${fmtCents(market.best_ask_cents)}`
      : null,
    market.fair_cents !== undefined ? `Fair ${fmtCents(market.fair_cents)}` : null,
    market.lifecycle_status ? `Status ${market.lifecycle_status}` : null,
  ].filter(Boolean).join('  ·  ');
  if (quote) lines.push(`  ${theme.muted(quote)}`);
  lines.push('');

  for (const key of SCORE_KEYS) {
    const score = market.scores[key];
    if (!score) continue;
    const why = score.not_applicable ? ' (not applicable)' : score.suppressed ? ' (suppressed — thin data)' : '';
    lines.push(`  ${SCORE_HEADER_LABELS[key].padEnd(10)}  ${colorScore(score.value)}/100  ${theme.muted(score.label ?? '')}${why}`);
    for (const d of (score.drivers ?? []).slice(0, 3)) {
      lines.push(`      • ${d}`);
    }
    if (verbose && (score.evidence?.length ?? 0) > 0) {
      lines.push(theme.muted(`      Evidence:`));
      for (const e of score.evidence!) {
        const window = e.window ? ` [${e.window}]` : '';
        lines.push(theme.muted(`        ${e.metric ?? e.text ?? '?'}: ${formatEvidenceValue(e.value ?? e.text)}${window}`));
      }
      if (score.confidence) lines.push(theme.muted(`      Confidence: ${score.confidence}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatEvidenceValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
