import { describe, test, expect } from 'bun:test';
import {
  DEFERRED_COMMANDS,
  COMMAND_FEATURE,
  isDeferredCommand,
  octagonSupports,
  octagonUnavailableMessage,
} from '../octagon-capabilities.js';
import { buildHelp } from '../../commands/help.js';

describe('octagon capabilities', () => {
  test('every deferred command maps to a feature', () => {
    for (const cmd of DEFERRED_COMMANDS) {
      expect(COMMAND_FEATURE[cmd]).toBeDefined();
    }
  });

  test('every deferred command is deferred because Octagon has no Polymarket route', () => {
    // Nothing stays gated for want of porting: the client now calls the
    // venue-generic routes, so a false here means Octagon serves Kalshi only.
    for (const cmd of DEFERRED_COMMANDS) {
      expect(octagonSupports(COMMAND_FEATURE[cmd]!)).toBe(false);
      expect(octagonUnavailableMessage(COMMAND_FEATURE[cmd]!, cmd)).toContain('Kalshi only');
    }
  });

  test('the venue-generic features are live', () => {
    for (const feature of ['market-search', 'similar-markets', 'events', 'reports', 'trader-trust'] as const) {
      expect(octagonSupports(feature)).toBe(true);
    }
  });

  test('isDeferredCommand only matches gated commands', () => {
    expect(isDeferredCommand('clusters')).toBe(true);
    expect(isDeferredCommand('series')).toBe(true);
    // These run against Polymarket — natively or via Octagon — and must stay available
    for (const live of ['search', 'analyze', 'watch', 'portfolio', 'catalysts', 'themes', 'help',
                        'report', 'trust', 'events', 'similar']) {
      expect(isDeferredCommand(live)).toBe(false);
    }
  });
});

describe('help reflects the gate', () => {
  const overview = () => {
    const r = buildHelp('cli');
    return 'text' in r ? r.text : '';
  };

  test('overview hides gated and unimplemented commands', () => {
    const text = overview();
    for (const cmd of DEFERRED_COMMANDS) {
      expect(text).not.toMatch(new RegExp(`^\\s{2}${cmd}\\b`, 'm'));
    }
    for (const cmd of ['buy', 'sell', 'cancel']) {
      expect(text).not.toMatch(new RegExp(`^\\s{2}${cmd}\\b`, 'm'));
    }
  });

  test('overview still lists the commands that work', () => {
    const text = overview();
    for (const cmd of ['search', 'analyze', 'watch', 'portfolio', 'backtest']) {
      expect(text).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });

  test('a gated topic leads with why it cannot run', () => {
    const r = buildHelp('cli', 'clusters');
    expect('text' in r).toBe(true);
    if ('text' in r) expect(r.text.startsWith('`clusters` is not available')).toBe(true);
  });

  test('help carries no Kalshi ticker examples', () => {
    const text = overview();
    expect(text).not.toMatch(/\bKX[A-Z0-9-]+/);
  });
});
