import { getDb } from '../db/index.js';
import { formatBoxHeader } from './formatters.js';
import { insertEdge } from '../db/edge.js';
import { getLatestReport } from '../db/octagon-cache.js';
import { auditTrail } from '../audit/index.js';
import { EdgeComputer } from '../scan/edge-computer.js';
import { OctagonClient } from '../scan/octagon-client.js';
import { createOctagonInvoker } from '../scan/invoker.js';
import * as readline from 'node:readline';
import { lookupMarket, normalizePolymarketInput } from '../tools/polymarket/markets.js';
import { fetchEventBySlug, searchEvents } from '../tools/polymarket/events.js';
import { fetchPositions } from '../tools/polymarket/portfolio.js';
import { TRADING_UNAVAILABLE_MESSAGE } from '../tools/polymarket/polymarket-trade.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';
import { openPosition, closePosition, getOpenPositions } from '../db/positions.js';
import { logTrade } from '../db/trades.js';
import { formatRawReport, parseMarketProb } from '../controllers/browse.js';
import type { PriceDriver, Catalyst, Source } from '../scan/types.js';
import { formatAge } from '../utils/time.js';
import { kellySize, getVolume24h } from '../risk/kelly.js';
import type { KellyResult } from '../risk/kelly.js';
import { riskGate } from '../risk/gate.js';
import { getBotSetting } from '../utils/bot-config.js';
import type { RiskGateResult } from '../risk/gate.js';
import { formatTable } from './scan-formatters.js';

export interface AnalyzeData {
  ticker: string;
  eventTicker: string;
  title: string;
  expirationTime: string | null;
  /** Local timestamp when we last pulled the report from Octagon. */
  refreshedAt: string | null;
  /** Upstream Octagon model-run timestamp (Octagon's `analysis_last_updated`). */
  modelRunAt: string | null;
  /**
   * True when --refresh just ran but the upstream `analysis_last_updated`
   * is unchanged from before the refresh. Tells the user we bumped the
   * cache time but didn't get a newer underlying report from Octagon.
   */
  staleUpstream: boolean;
  /**
   * Octagon's model probability for this market. null when hasModel is
   * false — we deliberately do NOT emit the 0.5 placeholder fallback to
   * JSON consumers. Always check hasModel before reading this field.
   */
  modelProb: number | null;
  /**
   * Last traded market probability. null when hasMarketPrice is false.
   * Always check hasMarketPrice before reading.
   */
  marketProb: number | null;
  /** modelProb − marketProb. null when either input is unavailable. */
  edge: number | null;
  /** Pretty-printed edge ("+14pp"). null when edge is null. */
  edgePp: string | null;
  /** "very_high" | "high" | "moderate" | "low" — null when edge is null. */
  confidence: string | null;
  /** "underpriced" | "overpriced" | "fair_value" — null when edge is null. */
  mispricingSignal: string | null;
  signal: string;
  drivers: PriceDriver[];
  catalysts: Catalyst[];
  sources: Source[];
  kelly: KellyResult;
  riskGate: RiskGateResult;
  liquidityGrade: string;
  fromCache: boolean;
  /**
   * True when Octagon has no model scoring for this market in the cached report.
   * When true, model probability + edge fields should be rendered as "--",
   * not as the 0.5 placeholder.
   */
  hasModel: boolean;
  /**
   * True when the Kalshi market has a `last_price` (it has actually traded).
   * When false, market_prob/edge/Kelly cannot be computed; the formatter
   * renders "--" for those fields and notes that the report was generated
   * without a tradeable price reference.
   *
   * The Octagon report itself still loads — only the trading-side math is
   * skipped. This is the common case for newly-listed event-level markets
   * (e.g. World Cup quarterfinal contracts before the bracket is set).
   */
  hasMarketPrice: boolean;
  reportAge: string | null;
  reportId: string;
  rawReport: string;
  existingPosition?: { direction: 'yes' | 'no'; size: number } | null;
  closePriceCents?: number | null;
}


function deriveLiquidityGrade(market: PolymarketMarket): string {
  const bid = market.yes_bid;
  const ask = market.yes_ask;
  const spreadCents = Number.isFinite(bid) && Number.isFinite(ask) ? Math.round((ask - bid) * 100) : 99;
  const volume = getVolume24h(market);
  if (spreadCents <= 2 && volume >= 5000) return 'Excellent';
  if (spreadCents <= 4 && volume >= 1000) return 'Good';
  return 'Poor';
}


function getVolume(m: PolymarketMarket): number {
  return Number.isFinite(m.volume) ? m.volume : 0;
}

/**
 * Normalize user input into a canonical Polymarket slug.
 *
 * Accepts any of:
 *   - Bare slug: `xi-jinping-out-before-2027`
 *   - Condition id: `0x…`
 *   - Polymarket URL: `https://polymarket.com/event/world-cup-winner`
 *   - Event URL with market: `polymarket.com/event/<event>/<market>?ref=foo`
 *
 * Unlike the Kalshi equivalent this does NOT uppercase: Polymarket slugs are
 * lowercase and the API is case-sensitive.
 */
export function normalizeMarketInput(input: string): string {
  return normalizePolymarketInput(input);
}

/**
 * Resolve user input to a market.
 * Accepts: market slug, condition id, event slug, Polymarket URL, or free text.
 * For events (and text search) the most liquid active market is chosen.
 */
export async function resolveMarket(rawInput: string): Promise<PolymarketMarket> {
  const input = normalizeMarketInput(rawInput);

  const pickBest = (markets: PolymarketMarket[]): PolymarketMarket | undefined => {
    const active = markets.filter((m) => m.status === 'active');
    const pool = active.length > 0 ? active : markets;
    return [...pool].sort((a, b) => getVolume(b) - getVolume(a))[0];
  };

  // 1. Try as a market slug or condition id
  const market = await lookupMarket(input);
  if (market?.ticker) return market;

  // 2. Try as an event slug — pick the most liquid active market inside it
  const event = await fetchEventBySlug(input);
  const fromEvent = pickBest(event?.markets ?? []);
  if (fromEvent) return fromEvent;

  // 3. Fall back to keyword search. Polymarket has no series-ticker prefix
  //    convention like Kalshi's KXBTC, so free text is the useful last resort.
  const results = await searchEvents(input.replace(/-/g, ' '), 5);
  const fromSearch = pickBest(results.flatMap((e) => e.markets ?? []));
  if (fromSearch) return fromSearch;

  throw new Error(
    `Could not find a market for "${rawInput}". Try a market slug (e.g. xi-jinping-out-before-2027), ` +
    `an event slug (e.g. world-cup-winner), a condition id (0x…), or a polymarket.com URL.`
  );
}

export async function handleAnalyze(
  ticker: string,
  refresh = false,
  providedPosition?: { direction: 'yes' | 'no'; size: number } | null,
): Promise<AnalyzeData> {
  const db = getDb();

  // Resolve input to a market — accepts market, event, or series tickers
  const market = await resolveMarket(ticker);
  const resolvedTicker = market.ticker;
  const eventTicker = market.event_ticker;
  const rawMarketProb = parseMarketProb(market);
  const hasMarketPrice = rawMarketProb !== null;

  // Many event-level Kalshi tickers exist before any contract has traded
  // (World Cup brackets, FOMC date ladders, IPO timing — there's no
  // last_price until someone takes a side). The Octagon report path doesn't
  // need market_prob — only the edge / Kelly / risk-gate math does. So we
  // keep going with a neutral fallback and mark hasMarketPrice = false so
  // the formatter renders "--" for the trading-side fields.
  const marketProb = hasMarketPrice ? rawMarketProb! : 0.5;

  const invoker = createOctagonInvoker();
  const octagonClient = new OctagonClient(invoker, db, auditTrail);
  const edgeComputer = new EdgeComputer(db, auditTrail);

  // Capture the upstream Octagon `analysis_last_updated` BEFORE the refresh
  // so we can detect when --refresh re-fetches the same stale upstream
  // report (cache fetch time bumped, but Octagon's underlying model run
  // didn't move). This catches "stale upstream" cases where the user thinks
  // they got fresh analysis but actually got the same body Octagon last
  // generated weeks ago.
  const preRefreshReport = refresh ? getLatestReport(db, resolvedTicker) : null;
  const preRefreshAnalysis = preRefreshReport?.analysis_last_updated ?? null;

  // Use cache by default; only refresh when explicitly requested
  // Try prefetch first to avoid an individual Octagon API call
  let variant: 'cache' | 'refresh' = refresh ? 'refresh' : 'cache';
  let report = (!refresh ? octagonClient.tryFromPrefetch(resolvedTicker, eventTicker) : null)
    ?? await octagonClient.fetchReport(resolvedTicker, eventTicker, variant);

  // If cache returned no meaningful data, auto-fetch fresh
  let usedFresh = refresh;
  if (!refresh && report.cacheMiss) {
    try {
      report = await octagonClient.fetchReport(resolvedTicker, eventTicker, 'refresh');
      usedFresh = true;
    } catch (err) {
      // Auto-refresh failed — continue with cache-miss report rather than crashing
      // The user can explicitly --refresh to retry
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠ Auto-refresh failed: ${msg}`);
      console.error(`  Showing cached data. Run \`analyze ${ticker} --refresh\` to retry.`);
    }
  }

  const fromCache = !usedFresh;
  const latestDbReport = getLatestReport(db, resolvedTicker);
  const reportAge = latestDbReport ? formatAge(latestDbReport.fetched_at) : null;

  // Decide trading-side gating BEFORE running edge / Kelly / signal math.
  // hasModel uses report.modelProb directly (snapshot.modelProb is just
  // propagated unchanged from computeEdge — verified in edge-computer.ts:38).
  // canComputeEdge is the contract: any trading decision (signal, Kelly,
  // mispricing) must check it first. Otherwise we'd build a "BUY YES @ $X"
  // recommendation from a 0.5 placeholder modelProb on uncovered events.
  const hasModel = !report.cacheMiss && Number.isFinite(report.modelProb)
    && !(report.modelProb === 0.5 && report.drivers.length === 0 && report.catalysts.length === 0);
  const canComputeEdge = hasModel && hasMarketPrice;

  const snapshot = edgeComputer.computeEdge(resolvedTicker, report, marketProb);

  // Persist edge
  insertEdge(db, {
    ticker: snapshot.ticker,
    event_ticker: snapshot.eventTicker,
    timestamp: snapshot.timestamp,
    model_prob: snapshot.modelProb,
    market_prob: snapshot.marketProb,
    edge: snapshot.edge,
    octagon_report_id: snapshot.octagonReportId,
    drivers_json: JSON.stringify(snapshot.drivers),
    sources_json: JSON.stringify(snapshot.sources),
    catalysts_json: JSON.stringify(snapshot.catalysts),
    cache_hit: fromCache ? 1 : 0,
    cache_miss: report.cacheMiss ? 1 : 0,
    confidence: snapshot.confidence,
  });

  // Kelly sizing — wrapped in try/catch for demo mode (portfolio endpoints may 401).
  // Skip Kelly entirely when there's no last_price: any sizing computed from
  // a 50% market_prob fallback would be meaningless.
  const emptyKelly: KellyResult = {
    side: snapshot.edge >= 0 ? 'yes' : 'no',
    fraction: 0,
    adjustedFraction: 0,
    shares: 0,
    notionalUsdc: 0,
    entryPrice: 0,
    availableBankroll: 0,
    openExposure: 0,
    cashBalance: 0,
    portfolioValue: 0,
    liquidityAdjusted: false,
  };
  let kelly: KellyResult;
  if (!canComputeEdge) {
    // Either no model coverage or no last_price → any sizing computed from
    // a placeholder modelProb / marketProb would be meaningless.
    kelly = emptyKelly;
  } else {
    try {
      kelly = await kellySize({
        edge: snapshot.edge,
        marketProb,
        market,
        multiplier: getBotSetting('risk.kelly_multiplier') as number | undefined,
        minEdgeThreshold: getBotSetting('risk.min_edge_threshold') as number | undefined,
      });
    } catch {
      kelly = { ...emptyKelly };
    }
  }

  // Risk gate
  const gate = riskGate({ ticker: resolvedTicker, eventTicker, kelly, market, db });

  // Use caller-provided position or fetch from API when not provided
  let existingPosition: { direction: 'yes' | 'no'; size: number } | null =
    providedPosition !== undefined ? (providedPosition ?? null) : null;
  if (providedPosition === undefined) {
    try {
      const positions = await fetchPositions();
      const match = positions.find((p) => p.ticker === resolvedTicker && p.size !== 0);
      if (match) {
        existingPosition = {
          // Positions are per outcome token, so direction is the outcome label.
          direction: match.outcome.toLowerCase() === 'no' ? 'no' : 'yes',
          size: Math.abs(match.size),
        };
      }
    } catch {
      // No wallet configured or Data API unavailable — continue without
    }
  }

  // Build signal — position-aware
  const side = snapshot.edge > 0 ? 'YES' : 'NO';
  const { yes_ask: yesAsk, no_ask: noAsk, yes_bid: yesBid, no_bid: noBid } = market;
  const entryPrice = (snapshot.edge > 0 ? yesAsk : noAsk);

  let signal: string;
  if (!canComputeEdge) {
    // Any actionable signal needs both a real model probability and a real
    // last_price. Spell out which one is missing so the user / bot knows
    // why we're not making a recommendation.
    const reason = !hasModel && !hasMarketPrice
      ? 'no Octagon model coverage and no last traded price'
      : !hasModel
        ? 'no Octagon model coverage for this market'
        : 'market has no last traded price';
    signal = `no signal (${reason})`;
  } else if (existingPosition) {
    const holdDir = existingPosition.direction.toUpperCase();
    const edgeReversed =
      (existingPosition.direction === 'yes' && snapshot.edge < -0.03) ||
      (existingPosition.direction === 'no' && snapshot.edge > 0.03);
    if (edgeReversed) {
      const closePrice = existingPosition.direction === 'yes' ? yesBid : noBid;
      signal = Number.isFinite(closePrice)
        ? `SELL ${holdDir} @ $${closePrice.toFixed(2)} (close position)`
        : `SELL ${holdDir} (close position)`;
    } else {
      signal = `HOLD (long ${holdDir} ×${existingPosition.size})`;
    }
  } else {
    signal = Number.isFinite(entryPrice) ? `BUY ${side} @ $${entryPrice.toFixed(2)}` : `BUY ${side}`;
  }
  const edgePp = `${snapshot.edge >= 0 ? '+' : ''}${(snapshot.edge * 100).toFixed(0)}pp`;

  const mispricingSignal = snapshot.edge > 0.02
    ? 'underpriced'
    : snapshot.edge < -0.02
      ? 'overpriced'
      : 'fair_value';

  // Audit
  auditTrail.log({
    type: 'RECOMMENDATION',
    ticker: resolvedTicker,
    action: signal,
    size: kelly.shares,
    kelly: kelly.adjustedFraction,
    risk_gate: gate.passed ? 'PASSED' : 'FAILED',
  });

  // Two distinct timestamps:
  //   refreshedAt = our local fetched_at (when WE pulled this from Octagon).
  //                 This is the "Refreshed" date — what bumps when --refresh runs.
  //   modelRunAt  = Octagon's analysis_last_updated (when their model last
  //                 scored this event). Independent of our cache.
  //
  // Load timestamps from a single coherent source — the row identified by
  // report.reportId is the exact row used for THIS analysis. The previous
  // implementation mixed fields from market-keyed and event-keyed rows
  // (different captured runs), so refreshedAt and modelRunAt could refer
  // to different snapshots.
  //
  // If the primary row doesn't carry analysis_last_updated (fetchReport
  // path doesn't expose it), fall back to the latest event-keyed prefetch
  // row for that field only — never for fetched_at.
  const primaryRow = report.reportId
    ? db.query(
        `SELECT fetched_at, analysis_last_updated FROM octagon_reports WHERE report_id = $rid`,
      ).get({ $rid: report.reportId }) as
        | { fetched_at: number; analysis_last_updated: string | null }
        | undefined
    : undefined;
  let fetchedAtEpoch = primaryRow?.fetched_at ?? null;
  let analysisLastUpdated = primaryRow?.analysis_last_updated ?? null;
  if ((!fetchedAtEpoch || !analysisLastUpdated) && eventTicker && eventTicker !== resolvedTicker) {
    const eventRow = db.query(
      `SELECT fetched_at, analysis_last_updated FROM octagon_reports
       WHERE event_ticker = $et AND variant_used = 'events-api'
       ORDER BY fetched_at DESC LIMIT 1`,
    ).get({ $et: eventTicker }) as { fetched_at: number; analysis_last_updated: string | null } | undefined;
    if (eventRow) {
      fetchedAtEpoch = fetchedAtEpoch ?? eventRow.fetched_at;
      analysisLastUpdated = analysisLastUpdated ?? eventRow.analysis_last_updated;
    }
  }
  const refreshedAt = fetchedAtEpoch
    ? new Date(fetchedAtEpoch * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : null;
  const modelRunAt = analysisLastUpdated
    ? analysisLastUpdated.replace('T', ' ').slice(0, 16) + ' UTC'
    : null;

  // hasModel + canComputeEdge were computed earlier (above Kelly/signal),
  // so trading-side math never reads a placeholder edge. See top of
  // handleAnalyze for the contract.

  // staleUpstream = user asked for --refresh but Octagon's upstream model run
  // timestamp didn't move. Cache fetch time bumped, but the underlying report
  // body is the same one Octagon previously generated. Compare against the
  // same coherent source we used for modelRunAt above — otherwise we could
  // false-positive on staleness when the two lookups disagreed.
  const staleUpstream = refresh
    && preRefreshAnalysis != null
    && analysisLastUpdated != null
    && preRefreshAnalysis === analysisLastUpdated;

  // Null out trading-side fields when the underlying inputs are unavailable.
  // JSON consumers previously saw modelProb: 0.5 / marketProb: 0.5 / edge: 0
  // on degraded paths and treated them as real predictions. The hasModel and
  // hasMarketPrice flags are the source of truth — fields here mirror them.
  // (canComputeEdge was already evaluated at the top of the function.)
  return {
    ticker: resolvedTicker,
    eventTicker,
    title: market.title || market.subtitle || resolvedTicker,
    expirationTime: market.expiration_time || market.expiration_time || market.close_time || null,
    refreshedAt,
    modelRunAt,
    staleUpstream,
    hasModel,
    hasMarketPrice,
    modelProb: hasModel ? snapshot.modelProb : null,
    marketProb: hasMarketPrice ? marketProb : null,
    edge: canComputeEdge ? snapshot.edge : null,
    edgePp: canComputeEdge ? edgePp : null,
    confidence: canComputeEdge ? snapshot.confidence : null,
    mispricingSignal: canComputeEdge ? mispricingSignal : null,
    signal,
    drivers: snapshot.drivers,
    catalysts: snapshot.catalysts,
    sources: snapshot.sources,
    kelly,
    riskGate: gate,
    liquidityGrade: deriveLiquidityGrade(market),
    fromCache,
    reportAge,
    reportId: report.reportId,
    rawReport: report.rawResponse,
    existingPosition,
    closePriceCents: existingPosition
      ? Math.round((existingPosition.direction === 'yes' ? yesBid : noBid) * 100) || null
      : null,
  };
}

export function formatAnalyzeHuman(data: AnalyzeData): string {
  const lines: string[] = [];

  lines.push(...formatBoxHeader('MARKET ANALYSIS'));
  lines.push('');
  lines.push(`  Title:      ${data.title}`);
  lines.push(`  Ticker:     ${data.ticker}`);
  lines.push(`  Event:      ${data.eventTicker}`);
  if (data.expirationTime) {
    const exp = new Date(data.expirationTime);
    lines.push(`  Expires:    ${exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${exp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`);
  }
  lines.push(`  Signal:     ${data.signal}`);
  if (data.existingPosition) {
    lines.push(`  Position:   ${data.existingPosition.direction.toUpperCase()} ×${data.existingPosition.size}`);
  }
  lines.push('');

  // Edge & Probabilities. Two independent reasons a field may be unavailable:
  //   hasModel=false       → Octagon has no model scoring → Model Prob shows "--"
  //   hasMarketPrice=false → Kalshi market has no last_price → Market Prob shows "--"
  // Edge needs both. Either being false means edge/confidence/mispricing
  // render "--" — we never show a number derived from a placeholder.
  const modelStr = data.hasModel && data.modelProb != null
    ? `${(data.modelProb * 100).toFixed(1)}%`
    : `--   (no Octagon model coverage for this market)`;
  const marketStr = data.hasMarketPrice && data.marketProb != null
    ? `${(data.marketProb * 100).toFixed(1)}%`
    : `--   (no last traded price — market hasn't traded yet)`;
  const canComputeEdge = data.hasModel && data.hasMarketPrice && data.edge != null;
  lines.push(`  Model Prob:  ${modelStr}`);
  lines.push(`  Market Prob: ${marketStr}`);
  if (canComputeEdge) {
    lines.push(`  Edge:        ${data.edgePp} (${(data.edge! * 100).toFixed(1)}%)`);
    lines.push(`  Confidence:  ${data.confidence}`);
    lines.push(`  Mispricing:  ${data.mispricingSignal}`);
  } else {
    lines.push(`  Edge:        --`);
    lines.push(`  Confidence:  --`);
    lines.push(`  Mispricing:  --`);
  }
  lines.push('');

  // Price Drivers
  if (data.drivers.length > 0) {
    lines.push('  Price Drivers:');
    for (const d of data.drivers) {
      const src = d.sourceUrl ? ` (${d.sourceUrl})` : '';
      lines.push(`    • [${d.impact.toUpperCase()}/${d.category}] ${d.claim}${src}`);
    }
    lines.push('');
  }

  // Catalyst Calendar
  if (data.catalysts.length > 0) {
    lines.push('  Catalyst Calendar:');
    const catRows = data.catalysts.map((c) => [
      c.date || '-',
      c.event,
      c.impact.toUpperCase(),
      c.potentialMove || '-',
    ]);
    lines.push(formatTable(
      ['Date', 'Event', 'Impact', 'Potential Move'],
      catRows,
    ));
    lines.push('');
  }

  // Position Sizing — only meaningful when there's a tradeable price.
  lines.push('  Position Sizing (Half-Kelly):');
  if (!data.hasMarketPrice) {
    lines.push('    ⚠ Skipped — market has no last traded price; no sizing reference available.');
  } else {
    lines.push(`    Side:         ${data.kelly.side.toUpperCase()}`);
    lines.push(`    Cash Balance: $${(data.kelly.cashBalance / 100).toFixed(2)}`);
    lines.push(`    Open Exposure: $${(data.kelly.openExposure / 100).toFixed(2)}`);
    lines.push(`    Available:    $${(data.kelly.availableBankroll / 100).toFixed(2)}`);
    lines.push(`    Contracts:    ${data.kelly.shares}`);
    lines.push(`    Dollar Amount: $${(data.kelly.notionalUsdc / 100).toFixed(2)}`);
    lines.push(`    Entry Price:  ${data.kelly.entryPrice}¢`);
    lines.push(`    Kelly f*:     ${(data.kelly.fraction * 100).toFixed(1)}%`);
    lines.push(`    Adjusted f:   ${(data.kelly.adjustedFraction * 100).toFixed(1)}%`);
    if (data.kelly.liquidityAdjusted) {
      lines.push('    ⚠ Liquidity-adjusted (wide spread or low volume)');
    }
    if (data.kelly.skippedReason) {
      lines.push(`    ⚠ ${data.kelly.skippedReason}`);
    }
  }
  lines.push('');

  // Risk Gate
  const gateIcon = data.riskGate.passed ? '✓' : '✗';
  lines.push(`  Risk Gate: ${gateIcon} ${data.riskGate.passed ? 'PASSED' : 'FAILED'}`);
  for (const check of data.riskGate.checks) {
    const icon = check.passed ? '✓' : '✗';
    lines.push(`    ${icon} ${check.name}: ${check.reason}`);
  }
  lines.push('');
  lines.push(`  Liquidity: ${data.liquidityGrade}`);

  // Sources
  if (data.sources.length > 0) {
    lines.push('');
    lines.push('  Sources:');
    for (const s of data.sources) {
      const title = s.title ? `${s.title}: ` : '';
      lines.push(`    • ${title}${s.url}`);
    }
  }

  // Two distinct timestamps — labeled with the wording users actually use:
  //
  //   Cache refreshed at    = when the bot last fetched/re-read the Octagon
  //                           payload. This is what bumps on --refresh.
  //   Report body updated at = the upstream Octagon `analysis_last_updated`
  //                            (matches the "Updated: …" date embedded in the
  //                            report body text). Doesn't change unless
  //                            Octagon re-runs their analysis upstream.
  //
  // If you're a bot/agent reading this output: use **Report body updated at**
  // to decide whether the underlying analysis is fresh. The Cache refreshed
  // at time only tells you when we last re-pulled the same body — it can be
  // recent while the report itself is weeks old.
  lines.push('');
  if (data.refreshedAt) {
    const ageSuffix = data.reportAge ? ` (${data.reportAge})` : '';
    lines.push(`  Cache refreshed at:    ${data.refreshedAt}${ageSuffix}`);
    lines.push(`                         ↳ when the bot last fetched the Octagon payload; bumps on --refresh`);
  }
  if (data.modelRunAt) {
    lines.push(`  Report body updated at: ${data.modelRunAt}`);
    lines.push(`                         ↳ when Octagon last ran the model upstream (the "Updated:" date inside the report)`);
  }
  if (data.staleUpstream) {
    lines.push('');
    lines.push(`  ⚠ --refresh pulled the same Octagon report body. The cache fetch time bumped,`);
    lines.push(`    but Octagon's upstream analysis hasn't been re-run since ${data.modelRunAt ?? 'an earlier date'}.`);
    lines.push(`    Treat this as a stale upstream report — no newer analysis is available.`);
  }
  if (data.fromCache) {
    lines.push(`  Data: cached. Run \`analyze ${data.ticker} --refresh\` for the latest report (costs 3 credits).`);
  } else {
    lines.push('  Data: freshly generated.');
  }

  return lines.join('\n');
}

/**
 * Interactive post-analyze menu. Presents options to view the full report,
 * refresh the report, or place the suggested trade.
 */
export async function promptAnalyzeActions(data: AnalyzeData): Promise<void> {
  if (!process.stdin.isTTY) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => {
    rl.question(q, (ans) => resolve(ans.trim()));
  });

  const menu = [
    '  1) View full report',
    '  2) Refresh report (costs credits)',
    '  3) Make suggested trade',
    '  4) Exit',
  ].join('\n');

  let running = true;
  while (running) {
    console.log(`\n${menu}`);
    const choice = await ask('\n  Choose [1-4]: ');

    switch (choice) {
      case '1': {
        if (data.rawReport) {
          console.log('\n' + formatRawReport(data.rawReport, data.ticker));
        } else {
          console.log('  No report available. Try option 2 to refresh.');
        }
        break;
      }

      case '2': {
        console.log('  Fetching fresh report…');
        try {
          const freshData = await handleAnalyze(data.ticker, true);
          data = freshData;
          console.log(formatAnalyzeHuman(data));
        } catch (err) {
          console.error(`  Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case '3': {
        // Order placement is deferred until wallet signing lands; the analysis
        // above is still fully usable, so only this action is blocked.
        console.log(`  ${TRADING_UNAVAILABLE_MESSAGE}`);
        break;
      }
      case '4':
      default:
        running = false;
        break;
    }
  }

  rl.close();
}
