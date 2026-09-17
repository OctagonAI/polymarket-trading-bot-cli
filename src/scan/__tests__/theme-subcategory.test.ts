import { describe, test, expect } from 'bun:test';
import { findTheme, parseThemeQuery } from '../theme-registry.js';

/**
 * `search sports:baseball` used to return 0 markets while the TUI returned 157
 * across 28 events. The cause: findTheme is a flat map lookup, so the composite
 * string missed, fell through to free-text `q=`, and no title contains the
 * literal "sports:baseball". The colon syntax is advertised by `search themes`
 * and honoured by both `scan` and the TUI, so the gap was in dispatch alone.
 */
describe('parseThemeQuery', () => {
  test('splits theme:subtheme into a theme and a raw subtheme', () => {
    expect(parseThemeQuery('sports:baseball').theme?.id).toBe('sports');
    expect(parseThemeQuery('sports:baseball').subtheme).toBe('baseball');
    expect(parseThemeQuery('crypto:btc').theme?.id).toBe('crypto');
    expect(parseThemeQuery('crypto:btc').subtheme).toBe('btc');
  });

  test('a bare theme has no subtheme', () => {
    expect(parseThemeQuery('crypto').theme?.id).toBe('crypto');
    expect(parseThemeQuery('crypto').subtheme).toBeUndefined();
  });

  test('aliases resolve on the left of the colon', () => {
    expect(parseThemeQuery('science:space').theme?.id).toBe('tech-science');
    expect(parseThemeQuery('entertainment:music').theme?.id).toBe('culture');
  });

  test('free text and unknown prefixes yield no theme', () => {
    expect(parseThemeQuery('bitcoin').theme).toBeUndefined();
    expect(parseThemeQuery('government shutdown').theme).toBeUndefined();
    expect(parseThemeQuery('nonsense:sub').theme).toBeUndefined();
  });

  test('tolerates case and whitespace, like findTheme', () => {
    expect(parseThemeQuery('  Crypto:BTC ').theme?.id).toBe('crypto');
    expect(parseThemeQuery('  Crypto:BTC ').subtheme).toBe('BTC');
    expect(findTheme('  Crypto ')?.id).toBe('crypto');
  });

  test('a trailing colon is treated as a bare theme', () => {
    expect(parseThemeQuery('crypto:').theme?.id).toBe('crypto');
    expect(parseThemeQuery('crypto:').subtheme).toBeUndefined();
  });
});
