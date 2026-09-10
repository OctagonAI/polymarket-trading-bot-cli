import { describe, test, expect } from 'bun:test';
import { normalizeMarketInput } from '../analyze.js';

describe('normalizeMarketInput', () => {
  test('passes through a bare market slug unchanged', () => {
    expect(normalizeMarketInput('xi-jinping-out-before-2027')).toBe('xi-jinping-out-before-2027');
    expect(normalizeMarketInput('will-switzerland-win-the-2026-fifa-world-cup')).toBe(
      'will-switzerland-win-the-2026-fifa-world-cup',
    );
  });

  test('preserves case', () => {
    // Unlike Kalshi tickers, Polymarket slugs are lowercase and the API is
    // case-sensitive — uppercasing here would 404 every lookup.
    expect(normalizeMarketInput('xi-jinping-out-before-2027')).toBe('xi-jinping-out-before-2027');
    expect(normalizeMarketInput('  world-cup-winner  ')).toBe('world-cup-winner');
  });

  test('passes through a condition id unchanged', () => {
    const cid = '0x2e1e684b3312b9f06072575f01fb77237e0b94bdcfcc477a553e8685cea91b82';
    expect(normalizeMarketInput(cid)).toBe(cid);
  });

  test('extracts the event slug from a full Polymarket URL', () => {
    expect(normalizeMarketInput('https://polymarket.com/event/world-cup-winner')).toBe(
      'world-cup-winner',
    );
  });

  test('prefers the market slug when the URL carries both', () => {
    expect(
      normalizeMarketInput('https://polymarket.com/event/world-cup-winner/will-brazil-win'),
    ).toBe('will-brazil-win');
  });

  test('extracts from a URL without protocol', () => {
    expect(normalizeMarketInput('polymarket.com/event/world-cup-winner')).toBe('world-cup-winner');
    expect(normalizeMarketInput('www.polymarket.com/event/world-cup-winner')).toBe(
      'world-cup-winner',
    );
  });

  test('handles /market/ URLs as well as /event/', () => {
    expect(normalizeMarketInput('https://polymarket.com/market/xi-jinping-out-before-2027')).toBe(
      'xi-jinping-out-before-2027',
    );
  });

  test('strips query string and fragment', () => {
    expect(normalizeMarketInput('https://polymarket.com/event/world-cup-winner?ref=share')).toBe(
      'world-cup-winner',
    );
    expect(normalizeMarketInput('https://polymarket.com/event/world-cup-winner#yes')).toBe(
      'world-cup-winner',
    );
    expect(
      normalizeMarketInput('https://polymarket.com/event/world-cup-winner/?ref=share#yes'),
    ).toBe('world-cup-winner');
  });

  test('strips trailing slashes', () => {
    expect(normalizeMarketInput('world-cup-winner/')).toBe('world-cup-winner');
    expect(normalizeMarketInput('world-cup-winner//')).toBe('world-cup-winner');
  });

  test('leaves free text alone so resolveMarket can search on it', () => {
    // resolveMarket falls back to keyword search when a slug lookup misses.
    expect(normalizeMarketInput('bitcoin price')).toBe('bitcoin price');
  });

  test('empty / whitespace input is left as empty', () => {
    expect(normalizeMarketInput('')).toBe('');
    expect(normalizeMarketInput('   ')).toBe('');
  });
});
