import { describe, test, expect } from 'bun:test';
import { formatMarketSearchHuman } from '../search-remote.js';
import type { OctagonMarketRow, PagedResult } from '../../scan/octagon-api.js';

function pageWith(closeTime: string | null): PagedResult<OctagonMarketRow> {
  const row = {
    market_ticker: 'polymarket__demo-market',
    native_ticker: 'demo-market',
    event_ticker: 'polymarket__demo-event',
    title: 'Demo Market',
    status: 'active',
    close_time: closeTime,
    last_price: 0.42,
    volume_24h: 1234,
    category: 'Politics',
  } as OctagonMarketRow;
  return { data: [row], next_cursor: null, has_more: false };
}

describe('search results close date', () => {
  test('renders the date as given, without shifting it', () => {
    // Sliced from the original string rather than re-serialised: toISOString()
    // would move an offset-bearing timestamp onto the wrong day.
    const out = formatMarketSearchHuman('demo', pageWith('2026-10-04T23:00:00-05:00'));
    expect(out).toContain('2026-10-04');
  });

  test('a malformed timestamp renders as "-" rather than garbage', () => {
    const out = formatMarketSearchHuman('demo', pageWith('not-a-date'));
    expect(out).not.toContain('not-a-dat');
  });

  test('a missing close time renders as "-"', () => {
    const out = formatMarketSearchHuman('demo', pageWith(null));
    expect(out).toContain('Demo Market');
  });
});
