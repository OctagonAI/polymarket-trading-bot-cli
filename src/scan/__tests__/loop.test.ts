import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

import { createDb } from '../../db/index.js';
import { AuditTrail } from '../../audit/trail.js';
import { ScanLoop } from '../loop.js';
import { upsertTheme } from '../../db/themes.js';
import { getLatestSnapshot } from '../../db/risk.js';
import { RiskSnapshotError } from '../../risk/circuit-breaker.js';
import * as erc20 from '../../chain/erc20.js';
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
  const spies: Array<{ mockRestore: () => void }> = [];

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

      // Polygon RPC — the pUSD balance. Without this the read fails, equity is
      // unknown, and a snapshot is refused outright rather than recorded as an
      // account worth nothing. 1000 pUSD in base units.
      if (urlStr.includes('drpc.org') || urlStr.includes('polygon')) {
        return json({ jsonrpc: '2.0', id: 1, result: `0x${(1_000_000_000).toString(16).padStart(64, '0')}` });
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
    for (const sp of spies.splice(0)) sp.mockRestore();
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

  test('a scan pass records a snapshot with account fields present', async () => {
    await loop.runOnce({ theme: 'test-theme' });

    const snapshot = getLatestSnapshot(db);
    expect(snapshot).not.toBeNull();
    // With a wallet address set, the Data API and the RPC are both read on every
    // pass and their mocked values land in the snapshot — previously these
    // columns were always 0 because the wallet path was switched off entirely.
    expect(snapshot!.portfolio_value).not.toBeNull();
    expect(snapshot!.open_exposure).not.toBeNull();
    // Both legs mocked, so equity is real. A pass that could not read the
    // balance would record nothing at all — see the refusal test below.
    expect(snapshot!.wallet_cash).toBe(1000);
    expect(snapshot!.equity).not.toBeNull();
    // cash_balance is deliberately NOT asserted: it falls back to the
    // risk.bankroll_usdc setting, which is legitimately non-zero on a developer
    // machine that has one configured.
  });

  test('drawdown stays 0 so the risk gate cannot trip on a phantom loss', async () => {
    // Drawdown is measured on equity, so closing a position is not a loss: the
    // value moves from one term to the other and equity is unchanged. A single
    // pass against a steady balance must therefore show no drawdown at all.
    await loop.runOnce({ theme: 'test-theme' });

    const snapshot = getLatestSnapshot(db);
    expect(snapshot!.drawdown_current).toBe(0);
    expect(snapshot!.drawdown_max).toBe(0);
  });

  test('a pass that cannot read the balance records nothing and says so', async () => {
    // A gated RPC is the case this guards: writing a row with drawdown 0 would
    // report safety the next time `check()` ran. The pass fails instead, and it
    // alerts on the way out — an unattended scanner that stops silently is the
    // failure nobody reports.
    const emitted: string[] = [];
    const alerter = (loop as unknown as { alerter: { emit(a: { message: string }): Promise<void> } }).alerter;
    const realEmit = alerter.emit.bind(alerter);
    alerter.emit = async (a) => {
      emitted.push(a.message);
      await realEmit(a);
    };
    spies.push(
      spyOn(erc20, 'readPusdBalance').mockImplementation(async () => null),
    );

    await expect(loop.runOnce({ theme: 'test-theme' })).rejects.toThrow(RiskSnapshotError);
    expect(getLatestSnapshot(db)).toBeNull();
    expect(emitted.join(' ')).toContain('scanning has stopped');
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
