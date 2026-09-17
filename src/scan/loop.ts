import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { ThemeResolver } from './theme-resolver.js';
import { EdgeComputer } from './edge-computer.js';
import { OctagonClient } from './octagon-client.js';
import { PositionWatchdog } from './watchdog.js';
import { Alerter, type AlertPayload, type AlertChannelDispatch } from './alerter.js';
import { CircuitBreaker, RiskSnapshotError } from '../risk/circuit-breaker.js';
import type { OctagonInvoker, EdgeSnapshot } from './types.js';
import type { RiskSnapshot } from '../db/risk.js';
import type { AuditTrail } from '../audit/trail.js';
import { getBotSetting } from '../utils/bot-config.js';

export interface ScanOpts {
  theme: string;
  forceRefresh?: boolean;
  dryRun?: boolean;
}

export interface ScanResult {
  scanId: string;
  eventsScanned: number;
  edgeSnapshots: EdgeSnapshot[];
  alerts: AlertPayload[];
  riskSnapshot: RiskSnapshot;
  octagonCreditsUsed: number;
  duration: number; // ms
}

const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * A configured numeric setting, or undefined when it is absent or unusable so
 * the consumer's own default applies rather than a coerced NaN or 0.
 */
function numericSetting(key: string): number | undefined {
  const raw = Number(getBotSetting(key));
  return Number.isFinite(raw) ? raw : undefined;
}

export class ScanLoop {
  private db: Database;
  private audit: AuditTrail;
  private themeResolver: ThemeResolver;
  private edgeComputer: EdgeComputer;
  private octagonClient: OctagonClient;
  private watchdog: PositionWatchdog;
  private alerter: Alerter;
  private circuitBreaker: CircuitBreaker;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private defaultChannels: string[];

  constructor(
    db: Database,
    audit: AuditTrail,
    octagonInvoker: OctagonInvoker,
    opts?: { alerter?: Alerter; defaultChannels?: string[] },
  ) {
    this.db = db;
    this.audit = audit;
    this.themeResolver = new ThemeResolver(db, audit);
    this.edgeComputer = new EdgeComputer(db, audit);
    this.octagonClient = new OctagonClient(octagonInvoker, db, audit);
    this.watchdog = new PositionWatchdog(audit);
    this.alerter = opts?.alerter ?? new Alerter(db, audit);
    // Without these the breaker silently used its own defaults (50 / 0.20) and
    // the configured limits did nothing.
    this.circuitBreaker = new CircuitBreaker({
      dailyLossLimit: numericSetting('risk.daily_loss_limit'),
      maxDrawdown: numericSetting('risk.max_drawdown'),
    });
    this.defaultChannels = opts?.defaultChannels ?? ['terminal'];
  }

  async runOnce(opts: ScanOpts): Promise<ScanResult> {
    const scanId = randomUUID();
    const start = Date.now();
    const alerts: AlertPayload[] = [];

    // Step 1: Resolve theme → event tickers
    const tickers = await this.themeResolver.resolve(opts.theme);

    // Steps 2-4: Pull markets, fetch Octagon, compute edge
    const edgeSnapshots = await this.edgeComputer.computeAll(tickers, this.octagonClient);

    // Step 5: Check open positions
    const watchdogAlerts = this.watchdog.check(this.db);

    // Step 6: Take risk snapshot.
    //
    // A refusal aborts the pass — a scan result carries a snapshot, and one
    // taken from an unreadable balance would be a fabrication. It is alerted
    // first: a gated RPC is the kind of failure nobody reports because nothing
    // says it happened, and console.error on an unattended process says nothing.
    let riskSnapshot;
    try {
      riskSnapshot = await this.circuitBreaker.snapshot(this.db);
    } catch (err) {
      if (err instanceof RiskSnapshotError && !opts.dryRun) {
        await this.alerter
          .emit({
            ticker: '*',
            alertType: 'CIRCUIT_BREAKER',
            edge: 0,
            message: `Risk snapshot failed, scanning has stopped: ${err.message}`,
            channels: this.defaultChannels,
          })
          .catch(() => {
            // The alert is the louder half of the report, not the whole of it;
            // the throw below still surfaces the failure.
          });
      }
      throw err;
    }

    // Step 7: Collect and emit alerts
    // Edge alerts for high/very_high confidence
    for (const snap of edgeSnapshots) {
      if (snap.confidence === 'high' || snap.confidence === 'very_high') {
        alerts.push({
          ticker: snap.ticker,
          alertType: 'EDGE_DETECTED',
          edge: snap.edge,
          message: `Edge ${(snap.edge * 100).toFixed(1)}% (${snap.confidence}) on ${snap.ticker}`,
          channels: this.defaultChannels,
        });
      }
    }

    // Watchdog alerts
    for (const wa of watchdogAlerts) {
      alerts.push({
        ticker: wa.ticker,
        alertType: wa.alertType,
        edge: wa.edge,
        message: wa.message,
        channels: this.defaultChannels,
      });
    }

    // Circuit breaker alert
    const cbStatus = this.circuitBreaker.check(this.db);
    if (cbStatus.active) {
      alerts.push({
        ticker: '*',
        alertType: 'CIRCUIT_BREAKER',
        edge: 0,
        message: `Circuit breaker active: ${cbStatus.reason}`,
        channels: this.defaultChannels,
      });
    }

    // Emit alerts (skip persistence when dryRun)
    if (!opts.dryRun) {
      for (const alert of alerts) {
        await this.alerter.emit(alert);
      }
    }

    // Step 8: Log SCAN_COMPLETE
    const duration = Date.now() - start;
    this.audit.log({
      type: 'SCAN_COMPLETE',
      scan_id: scanId,
      theme: opts.theme,
      events_scanned: tickers.length,
      edges_found: edgeSnapshots.length,
      duration_ms: duration,
    });

    return {
      scanId,
      eventsScanned: tickers.length,
      edgeSnapshots,
      alerts,
      riskSnapshot,
      octagonCreditsUsed: this.octagonClient.getCreditsUsed(),
      duration,
    };
  }

  start(opts: ScanOpts & { intervalMinutes?: number }): void {
    if (this.running) return;
    this.running = true;

    const rawMinInterval = Number(getBotSetting('watch.min_interval_minutes'));
    const minIntervalMinutes = Number.isFinite(rawMinInterval) && rawMinInterval > 0
      ? rawMinInterval
      : DEFAULT_INTERVAL_MINUTES;
    const minutes = Math.max(
      minIntervalMinutes,
      opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES
    );
    const ms = minutes * 60_000;

    // Run first cycle immediately
    this.runOnce(opts).catch((err) => {
      console.error('[ScanLoop] Error in scan cycle:', err);
    });

    this.intervalTimer = setInterval(() => {
      if (!this.running) return;
      this.runOnce(opts).catch((err) => {
        console.error('[ScanLoop] Error in scan cycle:', err);
      });
    }, ms);

    // Graceful shutdown handlers — use once() to prevent accumulation
    const shutdown = () => this.stop();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  stop(): void {
    this.running = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}
