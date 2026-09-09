import { describe, test, expect } from 'bun:test';
import { TRADING_COMMANDS, isTradingCommand } from '../../tools/polymarket/polymarket-trade.js';
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
    for (const live of ['search', 'analyze', 'watch', 'catalysts', 'themes', 'help',
                        'report', 'trust', 'events', 'similar', 'status']) {
      expect(isDeferredCommand(live)).toBe(false);
      expect(isTradingCommand(live)).toBe(false);
    }
  });

  test('portfolio is gated with the trading commands, not the Octagon ones', () => {
    // It reads an account, which needs the wallet trading setup provides.
    expect(isTradingCommand('portfolio')).toBe(true);
    expect(isDeferredCommand('portfolio')).toBe(false);
  });

  test('status survives the portfolio gate', () => {
    // `status` resolves to a portfolio subview, so a gate keyed on the canonical
    // command alone swallows it — it needs no wallet and must keep working.
    expect(isTradingCommand('status')).toBe(false);
    const r = buildHelp('cli');
    expect('text' in r && /^\s{2}status\b/m.test(r.text)).toBe(true);
  });
});

describe('help reflects the gate', () => {
  const overview = () => {
    const r = buildHelp('cli');
    return 'text' in r ? r.text : '';
  };

  test('overview hides gated and unimplemented commands', () => {
    const text = overview();
    for (const cmd of [...DEFERRED_COMMANDS, ...TRADING_COMMANDS]) {
      expect(text).not.toMatch(new RegExp(`^\\s{2}${cmd}\\b`, 'm'));
    }
  });

  test('overview still lists the commands that work', () => {
    const text = overview();
    // `status` earns its place here: it used to be reachable only as
    // `portfolio status`, and gating portfolio would otherwise bury it.
    for (const cmd of ['search', 'analyze', 'watch', 'backtest', 'status']) {
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
