import type { Database } from 'bun:sqlite';
import type { AuditTrail } from '../audit/trail.js';
import { fetchEventBySlug } from '../tools/polymarket/events.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';
import { insertEdge } from '../db/edge.js';
import { OctagonClient } from './octagon-client.js';
import type { OctagonReport, OctagonVariant, ConfidenceLevel, EdgeSnapshot } from './types.js';
import { isMarketActive, parseMarketProb } from '../controllers/browse.js';

const OCTAGON_CONCURRENCY = (() => {
  const parsed = parseInt(process.env.OCTAGON_CONCURRENCY ?? '5', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
})();

export class EdgeComputer {
  private db: Database;
  private audit: AuditTrail;

  constructor(db: Database, audit: AuditTrail) {
    this.db = db;
    this.audit = audit;
  }

  classifyConfidence(absEdge: number): ConfidenceLevel {
    if (absEdge >= 0.10) return 'very_high';
    if (absEdge >= 0.05) return 'high';
    if (absEdge >= 0.02) return 'moderate';
    return 'low';
  }

  computeEdge(ticker: string, octagonReport: OctagonReport, marketProb: number): EdgeSnapshot {
    const edge = octagonReport.modelProb - marketProb;
    const confidence = this.classifyConfidence(Math.abs(edge));

    return {
      ticker,
      eventTicker: octagonReport.eventTicker,
      modelProb: octagonReport.modelProb,
      marketProb,
      edge,
      confidence,
      drivers: octagonReport.drivers,
      catalysts: octagonReport.catalysts,
      sources: octagonReport.sources,
      octagonReportId: `${octagonReport.ticker}-${octagonReport.fetchedAt}`,
      cacheHit: octagonReport.variantUsed === 'cache',
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  async computeAll(tickers: string[], octagonClient: OctagonClient): Promise<EdgeSnapshot[]> {
    const snapshots: EdgeSnapshot[] = [];

    // Phase A: Collect all market tasks (Kalshi API calls are fast, keep sequential for rate limits)
    interface MarketTask {
      market: PolymarketMarket;
      eventTicker: string;
      marketProb: number;
      variant: OctagonVariant;
    }
    const tasks: MarketTask[] = [];

    for (const eventTicker of tickers) {
      try {
        const event = await fetchEventBySlug(eventTicker);
        const markets = event?.markets ?? [];

        for (const market of markets) {
          if (!isMarketActive(market)) continue;
          const marketProb = parseMarketProb(market);
          if (marketProb === null) continue; // no last traded price — skip
          const { refresh } = octagonClient.shouldRefresh(market.ticker, marketProb, false, market.close_time);
          tasks.push({ market, eventTicker, marketProb, variant: refresh ? 'refresh' : 'cache' });
        }
      } catch (err) {
        this.audit.log({
          type: 'OCTAGON_ERROR',
          ticker: eventTicker,
          event_ticker: eventTicker,
          error: String(err instanceof Error ? err.message : err),
        });
        continue;
      }
    }

    // Phase B: Process Octagon calls in parallel batches
    // Reserve credits synchronously before fanning out to prevent concurrent
    // refresh calls from overshooting the daily credit ceiling.
    for (let i = 0; i < tasks.length; i += OCTAGON_CONCURRENCY) {
      const batch = tasks.slice(i, i + OCTAGON_CONCURRENCY);

      // Reserve credits synchronously per-task before async fan-out
      const reservedBatch = batch.map((task) => ({
        ...task,
        reservedVariant: octagonClient.reserveRefresh(task.variant),
      }));

      const results = await Promise.allSettled(
        reservedBatch.map(async (task) => {
          // Try prefetch first to avoid individual cache API calls
          const prefetched = task.reservedVariant === 'cache'
            ? octagonClient.tryFromPrefetch(task.market.ticker, task.eventTicker, task.market.close_time)
            : null;
          const report = prefetched ?? await octagonClient.fetchReport(
            task.market.ticker, task.eventTicker, task.reservedVariant,
            { creditsPreReserved: true, closeTimeIso: task.market.close_time },
          );
          return { task, report };
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') {
          const failedTask = reservedBatch[i];
          this.audit.log({
            type: 'OCTAGON_ERROR',
            ticker: failedTask.market.ticker,
            event_ticker: failedTask.eventTicker,
            error: String(result.reason),
          });
          continue;
        }
        const { task, report } = result.value;
        const snapshot = this.computeEdge(task.market.ticker, report, task.marketProb);
        snapshots.push(snapshot);

        insertEdge(this.db, {
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
          cache_hit: snapshot.cacheHit ? 1 : 0,
          cache_miss: report.cacheMiss ? 1 : 0,
          confidence: snapshot.confidence,
        });

        if (Math.abs(snapshot.edge) >= 0.02) {
          this.audit.log({
            type: 'EDGE_DETECTED',
            ticker: snapshot.ticker,
            model_prob: snapshot.modelProb,
            market_prob: snapshot.marketProb,
            edge: snapshot.edge,
            confidence: snapshot.confidence,
            drivers: snapshot.drivers.map((d) => d.claim),
          });
        }
      }
    }

    return snapshots;
  }
}
