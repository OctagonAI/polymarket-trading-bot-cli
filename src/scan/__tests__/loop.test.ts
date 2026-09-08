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

    // Set required env vars for Kalshi API auth
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_PRIVATE_KEY = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCRFVyyjP3KGX63',
      '0/qa6kWsCdNJTbKMBaqTaYzCVKYWr3fA4UcA3Wx9+mXwYQ0+jULQP9Y1qWBpWTmb',
      'vnZaejJaywFK6LESStChcXuqN8uBcF13+CfwxVdbTboAbaHaNsOjHwl6JuYW0Nz+',
      'jOQmN0v/nT/SSq8BOLN7S408VW5yR3sC+W9oJ0qb6gVNJTHazxuEvCjz8k5w+a+D',
      'otAVUg/Y9WVIJqKhIhvQnD2pAN5J20RI4YXfz31GTaKzwMmg/ByoGrtkeJw4StFW',
      'HSVfo2/j9H1EdMTEHyjLyGyXjfiQOTSp/gK0BjaMHGzdltFueCOss8RoQjv2n+2m',
      'OL+aNv7tAgMBAAECggEAEkm0DpmxH/mIvJlO3JotQBtY88OEfxvzvXMvmAtdiDyE',
      'Bt8euSAwHc0jbmJ9beYWhvOVB9ya14y0s0oV1x/SGxm9xvh/4YNmuwL4CKPR1jYY',
      'wheYyUPG2C57BLTNExmWHYi7BBfFJxka0kdmNt7/iHAE7HgXiTrhfOgwHGvUaTki',
      'zDuq/I2rUaG4bDHA8EK19DdFCb2+TuqGYnc7vkMgwz2NajGZNXqOWCJabMVLeQR2',
      'niVRsFo2kY1uXB6Oy+nEixVnTxWRQhT//UWbLr4iJZnlJGpwPGKZZHhNADbx+w+0',
      'ig3iqVnYY11s7cceGTV7C9fGr+H9pERtTp3e1cPmLQKBgQDIP2WoJVz12wUd4ANM',
      'Jz1xpxsYg3txnTST01OidaWxeaDHg/mjzsdKPdMa7eBREJYy4HUllLZrvI9KWp/4',
      'wLCB0aCuytGf6Z2u/bOoTs87HMf13PzC0ksD1Ri9wEECN5NlVnL9NNcnpPE+6gGY',
      '2OzJtzfdr5JwPC5U12IDQVEAWwKBgQC5eiZhZKwHHeQQzJqgURDd3hZJpQdFDcFp',
      'QSH1dNHNdNutTLZ7JakSQcoz9P4Fuu4AEPGCi94xH4NoIq7fPY4ABX0a3vp9guJ+',
      'txChCHusjwVGGcraGSiognyxBnewpt+lzv1xDWBmmGaDqSVayS9eQaEiMypHbaah',
      '2vsiQBWgVwKBgC/EN6qZZwhae2j5869puNVwiB0b2Als94q/oTaim6ivG7Qb/iOe',
      'ApnqD35f+d88dqeiNS+GvtEKRJ/26Cv9Qt1ktNCdHs3ney6v4/gk/HfcULKMSVrr',
      'sOs0HNe+kYNG4IkOyxUtUplpVgas6T6dmDYx10ixRdwx7tdcHUwre3f7AoGARkWP',
      'UQsRWkjq5ap/Uwojt8uy6ggKbxE9HCG/Of4elxcVO916rcGhAvfGIlVKAOXH0mKY',
      '/fr8HeRwpv2s/4uUx1FNCuc8RF1YbuXw+PH72W7+cobHIkax7tYxY+itZFJ1HZ8E',
      'ytZklbpb7LojGvhqZ+25nPmBpTpYDa6nw1xAVVUCgYEAqKcg/QSJIcj+qODjtZZ8',
      'aCqNvagzw74Hruh9jmd3tLvqpzKN72GqdtuzRoGi2BzmjUkrTXhEugf4/AaxfLMy',
      'yk6j0nzHRSVi1GUzx/P/q6gsR8bEvhhBSZEwQxcQDL+1Toamz1nmFXLZo0w3hi6q',
      'wZ0ONbXRO/Hcg1MzeK10biQ=',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    // Seed theme with one event ticker
    upsertTheme(db, { theme_id: 'test-theme', name: 'Test', tickers: '["EV-1"]' });

    // Mock fetch for all Kalshi API calls
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // Extract path from full URL
      const match = urlStr.match(/\/trade-api\/v2(\/[^?]*)/);
      const path = match?.[1] ?? '';

      // Events endpoint
      if (path === '/events/EV-1' || urlStr.includes('/events/EV-1')) {
        return new Response(JSON.stringify({
          event: {
            event_ticker: 'EV-1',
            markets: [{
              ticker: 'MKT-YES',
              event_ticker: 'EV-1',
              status: 'open',
              last_price: 58,
              yes_bid: 55,
              yes_ask: 61,
              volume_24h: 1000,
            }],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Portfolio balance
      if (path === '/portfolio/balance') {
        return new Response(JSON.stringify({
          balance: 100_000,
          payout: 20_000,
          reserved_fees: 0,
          fees: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Portfolio positions
      if (path === '/portfolio/positions') {
        return new Response(JSON.stringify({
          market_positions: [{ market_exposure: 20_000 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    loop = new ScanLoop(db, audit, makeMockInvoker());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    loop.stop();
    delete process.env.POLYMARKET_API_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;
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

  test('creates risk_snapshots with bankroll data', async () => {
    await loop.runOnce({ theme: 'test-theme' });

    const snapshot = getLatestSnapshot(db);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.cash_balance).toBe(100_000);
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
