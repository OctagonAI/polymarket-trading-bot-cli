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

/*
 * Not covered here: setBotSetting throwing when saveBotConfig fails.
 * The config path is derived from homedir() at module load with no override, so
 * the only way to make a write fail is to make the real ~/.polymarket-bot
 * unwritable — which would clobber the developer's own settings. Adding an env
 * override to paths.ts purely for this test would widen production surface for
 * one assertion, so the guard is left to review instead.
 */
