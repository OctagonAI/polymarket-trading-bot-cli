import { describe, test, expect } from 'bun:test';
import { setBotSetting, getBotSetting } from '../../utils/bot-config.js';

/**
 * The bankroll is the one risk setting a user MUST supply — Polymarket has no
 * cash-balance endpoint, so it cannot be derived — which makes it the one most
 * worth validating. A bad value that silently lands as 0 or NaN is
 * indistinguishable from never having set it.
 */
describe('risk.bankroll_usdc', () => {
  test('is a known key that defaults to zero, meaning "sizing disabled"', () => {
    expect(getBotSetting('risk.bankroll_usdc')).toBeDefined();
  });

  test('rejects a negative amount rather than sizing against it', () => {
    expect(() => setBotSetting('risk.bankroll_usdc', '-5')).toThrow(/must be >= 0/);
  });

  test('rejects a non-number rather than storing NaN', () => {
    expect(() => setBotSetting('risk.bankroll_usdc', 'abc')).toThrow(/Invalid number/);
  });
});
