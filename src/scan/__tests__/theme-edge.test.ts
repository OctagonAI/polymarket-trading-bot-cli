import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDb } from '../../db/index.js';
import { AuditTrail } from '../../audit/trail.js';
import { EdgeComputer } from '../edge-computer.js';
import { ThemeResolver } from '../theme-resolver.js';
import { OctagonClient } from '../octagon-client.js';
import { upsertEvent, getActiveEvents } from '../../db/events.js';
import { getLatestEdge } from '../../db/edge.js';
import * as polyEvents from '../../tools/polymarket/events.js';
import type { OctagonReport, OctagonVariant } from '../types.js';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Helpers ---

function makeAudit(): AuditTrail {
  return new AuditTrail(join(tmpdir(), `test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`));
}

function makeMockReport(overrides: Partial<OctagonReport> = {}): OctagonReport {
  return {
    ticker: 'TICK-YES',
    eventTicker: 'EV-1',
    modelProb: 0.72,
    marketProb: 0.65,
    mispricingSignal: 'underpriced',
    drivers: [
      { claim: 'Strong momentum', category: 'political', impact: 'high' },
      { claim: 'Favorable conditions', category: 'economic', impact: 'medium' },
    ],
    catalysts: [
      { date: '2026-03-25', event: 'Key vote', impact: 'high', potentialMove: '+/- 8%' },
    ],
    sources: [
      { url: 'https://example.com/source1', title: 'Source One' },
    ],
    resolutionHistory: 'No prior resolution.',
    contractSnapshot: 'Yes at $0.65',
    variantUsed: 'default',
    fetchedAt: Math.floor(Date.now() / 1000),
    rawResponse: '',
    cacheMiss: false,
    reportId: '',
    ...overrides,
  };
}

// --- Tests ---

describe('EdgeComputer', () => {
  let db: Database;
  let audit: AuditTrail;
  let computer: EdgeComputer;

  beforeEach(() => {
    db = createDb(':memory:');
    audit = makeAudit();
    computer = new EdgeComputer(db, audit);
  });

  describe('classifyConfidence', () => {
    test('boundary values', () => {
      expect(computer.classifyConfidence(0.019)).toBe('low');
      expect(computer.classifyConfidence(0.02)).toBe('moderate');
      expect(computer.classifyConfidence(0.05)).toBe('high');
      expect(computer.classifyConfidence(0.10)).toBe('very_high');
      expect(computer.classifyConfidence(0.101)).toBe('very_high');
    });
  });

  describe('computeEdge', () => {
    test('computes positive edge correctly', () => {
      const report = makeMockReport({ modelProb: 0.72 });
      const snapshot = computer.computeEdge('TICK', report, 0.58);

      expect(snapshot.edge).toBeCloseTo(0.14, 10);
      expect(snapshot.confidence).toBe('very_high');
      expect(snapshot.ticker).toBe('TICK');
      expect(snapshot.modelProb).toBe(0.72);
      expect(snapshot.marketProb).toBe(0.58);
      expect(snapshot.drivers).toHaveLength(2);
      expect(snapshot.catalysts).toHaveLength(1);
      expect(snapshot.sources).toHaveLength(1);
    });

    test('computes negative edge correctly', () => {
      const report = makeMockReport({ modelProb: 0.72 });
      const snapshot = computer.computeEdge('TICK', report, 0.85);

      expect(snapshot.edge).toBeCloseTo(-0.13, 10);
      expect(snapshot.confidence).toBe('very_high');
    });

    test('small edge classifies as low confidence', () => {
      const report = makeMockReport({ modelProb: 0.50 });
      const snapshot = computer.computeEdge('TICK', report, 0.51);

      expect(snapshot.edge).toBeCloseTo(-0.01, 10);
      expect(snapshot.confidence).toBe('low');
    });
  });

  describe('computeAll', () => {
    test('inserts edge into DB and returns snapshots', async () => {
      const marketTicker = 'MKT-YES';
      const eventTicker = 'EV-1';

      // Mock the Gamma event fetch; prices are decimal probabilities
      const spy = spyOn(polyEvents, 'fetchEventBySlug').mockResolvedValue({
        event_ticker: eventTicker,
        title: 'Test event',
        sub_title: '',
        mutually_exclusive: false,
        category: 'politics',
        tags: [],
        close_time: '',
        strike_date: '',
        volume: 10000,
        volume_24h: 1000,
        liquidity: 5000,
        markets: [{
          ticker: marketTicker,
          event_ticker: eventTicker,
          status: 'active',
          last_price: 0.58,
          yes_bid: 0.55,
          yes_ask: 0.61,
          volume_24h: 1000,
        }],
      } as never);

      // Mock OctagonClient
      const mockInvoker = async (_ticker: string, _variant: OctagonVariant) => {
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
      const octagonClient = new OctagonClient(mockInvoker, db, audit);

      const snapshots = await computer.computeAll([eventTicker], octagonClient);

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].ticker).toBe(marketTicker);
      // marketProb = (55 + 61) / 2 / 100 = 0.58
      expect(snapshots[0].marketProb).toBeCloseTo(0.58, 10);
      expect(snapshots[0].modelProb).toBe(0.72);
      expect(snapshots[0].edge).toBeCloseTo(0.14, 10);
      expect(snapshots[0].confidence).toBe('very_high');

      // Verify DB insertion
      const row = getLatestEdge(db, marketTicker);
      expect(row).not.toBeNull();
      expect(row!.ticker).toBe(marketTicker);
      expect(row!.model_prob).toBe(0.72);
      expect(row!.market_prob).toBeCloseTo(0.58, 10);
      expect(row!.confidence).toBe('very_high');

      spy.mockRestore();
    });
  });
});

describe('ThemeResolver', () => {
  let db: Database;
  let audit: AuditTrail;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createDb(':memory:');
    audit = makeAudit();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('deactivates expired events after resolve', async () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert events: one expired, one active
    upsertEvent(db, { ticker: 'EXPIRED-EV', active: 1, expiry: now - 3600, updated_at: now - 7200 });
    upsertEvent(db, { ticker: 'ACTIVE-EV', active: 1, expiry: now + 3600, updated_at: now - 7200 });

    // Mock fetch — not needed for custom theme but required for the module
    globalThis.fetch = mock(async () => new Response('{}')) as unknown as typeof fetch;

    // Use custom theme that resolves to empty (custom theme with no stored tickers)
    const resolver = new ThemeResolver(db, audit);
    await resolver.resolve('nonexistent-custom-theme');

    // Check that expired event is deactivated
    const active = getActiveEvents(db);
    const activeTickers = active.map((e) => e.ticker);
    expect(activeTickers).not.toContain('EXPIRED-EV');
    expect(activeTickers).toContain('ACTIVE-EV');
  });
});
