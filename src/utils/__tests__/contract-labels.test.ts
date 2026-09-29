import { describe, test, expect } from 'bun:test';
import { contractLabels } from '../contract-labels.js';

describe('contractLabels', () => {
  test('strips the event prefix the sub-markets share, keeping the event market whole', () => {
    expect(contractLabels([
      'mlb-wsh-det-2026-09-23',
      'mlb-wsh-det-2026-09-23-nrfi',
      'mlb-wsh-det-2026-09-23-total-7pt5',
      'mlb-wsh-det-2026-09-23-f5-spread-away-1pt5',
    ], 'mlb-wsh-det-2026-09-23')).toEqual([
      'mlb-wsh-det-2026-09-23',
      'nrfi',
      'total-7pt5',
      'f5-spread-away-1pt5',
    ]);
  });

  test('strips shared words at both ends when the slugs do not start with the event', () => {
    expect(contractLabels([
      'bitcoin-above-66k-on-september-23-2026',
      'bitcoin-above-68k-on-september-23-2026',
      'bitcoin-above-70k-on-september-23-2026',
    ], 'bitcoin-above-on-september-23-2026')).toEqual(['66k', '68k', '70k']);

    expect(contractLabels([
      'will-dan-sullivan-win-the-alaska-senate-race-in-2026',
      'will-ann-diener-win-the-alaska-senate-race-in-2026',
    ], 'alaska-senate-election-winner')).toEqual(['dan-sullivan', 'ann-diener']);
  });

  test('always leaves at least one word, even when one slug extends another', () => {
    expect(contractLabels(['will-x-win', 'will-x-win-again'], 'x-event')).toEqual(['win', 'win-again']);
  });

  test('with one sub-market there is nothing to compare, so only the event prefix goes', () => {
    expect(contractLabels(['fed-oct-hold', 'fed-oct'], 'fed-oct')).toEqual(['hold', 'fed-oct']);
    expect(contractLabels(['will-trump-acquire-greenland-before-2027'], 'greenland')).toEqual([
      'will-trump-acquire-greenland-before-2027',
    ]);
  });
});
