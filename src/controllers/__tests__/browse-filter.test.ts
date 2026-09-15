import { describe, test, expect } from 'bun:test';
import { isMarketActive, type MarketRow } from '../browse.js';

function market(over: Partial<MarketRow> = {}): MarketRow {
  return { status: 'active', result: '', volume_24h: 1000, last_price: 0.5, ...over } as MarketRow;
}

describe('isMarketActive', () => {
  test('a quiet market with lifetime volume is still tradeable', () => {
    // The regression this guards: requiring volume_24h > 0 hid the large
    // majority of the index — markets with real lifetime volume but a quiet
    // last 24h, which is normal for long-dated contracts.
    expect(isMarketActive(market({ volume_24h: 0, volume: 1730.18 } as Partial<MarketRow>))).toBe(true);
  });

  test('a market that has never traded is still tradeable', () => {
    expect(isMarketActive(market({ volume_24h: 0, last_price: 0 }))).toBe(true);
  });

  test('volume filtering is opt-in, not implicit', () => {
    expect(isMarketActive(market({ volume_24h: 0 }))).toBe(true);
    expect(isMarketActive(market({ volume_24h: 5_000_000 }))).toBe(true);
  });

  test('non-tradeable states are excluded', () => {
    expect(isMarketActive(market({ status: 'closed' }))).toBe(false);
    expect(isMarketActive(market({ status: 'resolved' }))).toBe(false);
  });

  test('a resolved market is excluded', () => {
    expect(isMarketActive(market({ result: 'yes' }))).toBe(false);
  });

  test('open and active both count as tradeable', () => {
    expect(isMarketActive(market({ status: 'open' }))).toBe(true);
    expect(isMarketActive(market({ status: 'active' }))).toBe(true);
  });
});
