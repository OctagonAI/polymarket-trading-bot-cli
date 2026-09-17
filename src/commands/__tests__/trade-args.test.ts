import { describe, test, expect } from 'bun:test';
import { validateTradeArgs } from '../help.js';

/**
 * `validateTradeArgs` was carried over from Kalshi, where prices were integer
 * cents 1–99 and sizes were whole contracts. Polymarket prices are decimal USDC
 * in (0, 1) and outcome tokens are fractional, so the old `/^\d+$/` checks
 * rejected both the price format the CLI prints and the size its own Kelly
 * sizing recommends.
 */

function ok(r: ReturnType<typeof validateTradeArgs>) {
  if ('error' in r) throw new Error(`expected success, got: ${r.error}`);
  return r;
}

function err(r: ReturnType<typeof validateTradeArgs>) {
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('validateTradeArgs — size', () => {
  test('accepts fractional shares', () => {
    expect(ok(validateTradeArgs('12.5')).count).toBe(12.5);
    expect(ok(validateTradeArgs('0.25')).count).toBe(0.25);
    expect(ok(validateTradeArgs('25')).count).toBe(25);
  });

  test('rejects zero, negatives and non-numbers', () => {
    for (const bad of ['0', '-5', 'abc', '', ' ', '1e3', 'Infinity', 'NaN']) {
      expect(err(validateTradeArgs(bad))).toContain('Invalid size');
    }
  });
});

describe('validateTradeArgs — price', () => {
  test('accepts decimal USDC inside (0, 1)', () => {
    expect(ok(validateTradeArgs('10', '0.56')).price).toBe(0.56);
    expect(ok(validateTradeArgs('10', '0.01')).price).toBe(0.01);
    expect(ok(validateTradeArgs('10', '.5')).price).toBe(0.5);
  });

  test('omitting the price leaves it undefined — a market order', () => {
    expect(ok(validateTradeArgs('10')).price).toBeUndefined();
  });

  test('rejects Kalshi-style integer cents', () => {
    // The old validator accepted these and rejected 0.56. A bare `56` now reads
    // as $56/share, which is not a price a prediction market can have.
    expect(err(validateTradeArgs('10', '56'))).toContain('between 0 and 1');
  });

  test('rejects the resolved endpoints and anything outside the band', () => {
    for (const bad of ['0', '1', '1.5', '-0.2', 'abc', '']) {
      expect(err(validateTradeArgs('10', bad))).toContain('Invalid price');
    }
  });
});
