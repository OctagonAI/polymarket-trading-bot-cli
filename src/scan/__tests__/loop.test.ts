import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

import { createDb } from '../../db/index.js';
import { AuditTrail } from '../../audit/trail.js';
import { ScanLoop } from '../loop.js';
import { upsertTheme } from '../../db/themes.js';
import { getLatestSnapshot } from '../../db/risk.js';
import type { OctagonVariant } from '../types.js';

function makeAudit(): { audit: AuditTrail; path: string } {
  const path = join(tmpdir(), `test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  return { audit: new AuditTrail(path), path };
}

function makeMockInvoker() {
  return async (_ticker: string, _variant: OctagonVariant) => {
    return JSON.stringify({
      modelProb: 72,
      marketProb: 58,
      mispricingSignal: 'underpriced',
      drivers: [{ claim: 'Test driver', category: 'economic', impact: 'high' }],
      catalysts: [],
      sources: [],
      resolutionHistory: '',
      contractSnapshot: '',
    });
  };
}

describe('ScanLoop', () => {
  let db: Database;
  let audit: AuditTrail;
  let auditPath: string;
  let loop: ScanLoop;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createDb(':memory:');
    const a = makeAudit();
    audit = a.audit;
    auditPath = a.path;

    // Set, but deliberately inert: getWalletAddress ignores it until the wallet
    // phase. Kept here so this test fails loudly if that ever silently changes.
    process.env.POLYMARKET_WALLET_ADDRESS = '0x' + '1'.repeat(40);

    // Seed theme with one event ticker
    upsertTheme(db, { theme_id: 'test-theme', name: 'Test', tickers: '["EV-1"]' });

    // Mock fetch for Gamma (events) and the Data API (portfolio)
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

      // Gamma events — prices are decimal probabilities
      if (urlStr.includes('gamma-api.polymarket.com/events')) {
        return json([{
          slug: 'EV-1',
          title: 'Test event',
          tags: [{ label: 'politics' }],
          endDate: '',
          markets: [{
            slug: 'MKT-YES',
            conditionId: '0x' + 'a'.repeat(64),
            question: 'Test market',
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.58", "0.42"]',
            clobTokenIds: '["1", "2"]',
            lastTradePrice: 0.58,
            bestBid: 0.55,
            bestAsk: 0.61,
            volume24hr: 1000,
            active: true,
            closed: false,
            events: [{ slug: 'EV-1' }],
          }],
        }]);
      }

      // Data API portfolio value + positions (USDC)
      if (urlStr.includes('data-api.polymarket.com/value')) {
        return json([{ user: '0x1', value: 1000 }]);
      }
      if (urlStr.includes('data-api.polymarket.com/positions')) {
        return json([{ slug: 'MKT-OTHER', conditionId: '0xb', size: 100, curPrice: 0.5, currentValue: 200 }]);
      }

      return json({});
    }) as unknown as typeof fetch;

    loop = new ScanLoop(db, audit, makeMockInvoker());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    loop.stop();
    delete process.env.POLYMARKET_WALLET_ADDRESS;
  });

  test('runs one full scan cycle', async () => {
    const result = await loop.runOnce({ theme: 'test-theme' });

    expect(result.scanId).toBeTruthy();
    expect(result.eventsScanned).toBe(1);
    expect(result.edgeSnapshots.length).toBe(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('inserts edge_history rows', async () => {
    await loop.runOnce({ theme: 'test-theme' });

    const rows = db.query('SELECT * FROM edge_history').all() as Array<{ ticker: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].ticker).toBe('MKT-YES');
  });

  test('risk_snapshots record no account data while the wallet path is disabled', async () => {
    await loop.runOnce({ theme: 'test-theme' });

    const snapshot = getLatestSnapshot(db);
    expect(snapshot).not.toBeNull();
    // The wallet is off until the trading phase, so the Data API is never read
    // even though POLYMARKET_WALLET_ADDRESS is set above.
    expect(snapshot!.portfolio_value).toBe(0);
    expect(snapshot!.open_exposure).toBe(0);
    expect(snapshot!.cash_balance).toBe(0);
  });

  test('drawdown stays 0 so the risk gate cannot trip on a phantom loss', async () => {
    // portfolio_value is mark-to-market position value with no cash term, so if
    // the wallet were live, closing positions would read as a ~100% drawdown and
    // fail every later analyze. With the wallet off the high-water mark stays 0
    // and the drawdown branch is never taken. Guards the regression directly.
    await loop.runOnce({ theme: 'test-theme' });

    const snapshot = getLatestSnapshot(db);
    expect(snapshot!.drawdown_current).toBe(0);
    expect(snapshot!.drawdown_max).toBe(0);
  });

  test('audit trail has SCAN_START and SCAN_COMPLETE', async () => {
    await loop.runOnce({ theme: 'test-theme' });

    const lines = readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const types = lines.map((l: { type: string }) => l.type);
    expect(types).toContain('SCAN_START');
    expect(types).toContain('SCAN_COMPLETE');
  });

  test('emits alerts for high-confidence edges', async () => {
    const result = await loop.runOnce({ theme: 'test-theme' });

    // Edge of ~0.14 = very_high confidence → should produce EDGE_DETECTED alert
    const edgeAlerts = result.alerts.filter((a) => a.alertType === 'EDGE_DETECTED');
    expect(edgeAlerts.length).toBeGreaterThanOrEqual(1);

    // Alert should be persisted to DB
    const dbAlerts = db.query('SELECT * FROM alerts').all();
    expect(dbAlerts.length).toBeGreaterThanOrEqual(1);
  });

  test('dryRun computes but skips alert persistence', async () => {
    const result = await loop.runOnce({ theme: 'test-theme', dryRun: true });

    // Alerts should still be collected in result
    expect(result.alerts.length).toBeGreaterThanOrEqual(1);

    // But NOT persisted to the alerts table
    const dbAlerts = db.query('SELECT * FROM alerts').all();
    expect(dbAlerts.length).toBe(0);
  });
});
