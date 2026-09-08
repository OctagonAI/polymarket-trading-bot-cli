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

  test('no Octagon feature is available for Polymarket yet', () => {
    for (const cmd of DEFERRED_COMMANDS) {
      expect(octagonSupports(COMMAND_FEATURE[cmd]!)).toBe(false);
    }
  });

  test('distinguishes "not ported yet" from "Octagon has no equivalent"', () => {
    // report has a venue-generic endpoint; we just have not repointed the client
    expect(octagonUnavailableMessage('reports', 'report')).toContain('venue-generic');
    // clusters has no Polymarket equivalent at all
    expect(octagonUnavailableMessage('clusters', 'clusters')).toContain('Kalshi only');
  });

  test('isDeferredCommand only matches gated commands', () => {
    expect(isDeferredCommand('clusters')).toBe(true);
    expect(isDeferredCommand('report')).toBe(true);
    // These run natively against Polymarket and must stay available
    for (const live of ['search', 'analyze', 'watch', 'portfolio', 'catalysts', 'themes', 'help']) {
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
