import { describe, test, expect, spyOn } from 'bun:test';
import {
  TRADING_COMMANDS,
  KEY_COMMANDS,
  isTradingCommand,
  isCommandAvailable,
} from '../../tools/polymarket/polymarket-trade.js';
import { resetWalletIdentityCache } from '../../wallet/identity.js';
import * as walletStore from '../../wallet/store.js';
import {
  DEFERRED_COMMANDS,
  COMMAND_FEATURE,
  isDeferredCommand,
  octagonSupports,
  octagonUnavailableMessage,
} from '../octagon-capabilities.js';
import { buildHelp } from '../../commands/help.js';


/**
 * Run `fn` with no wallet visible from any source.
 *
 * The env vars alone are not enough: `loadWalletIdentity` also reads
 * ~/.polymarket-bot/wallet.json, so without stubbing the store these assertions
 * pass or fail depending on whether the developer running them has a wallet.
 */
function withNoWallet<T>(fn: () => T): T {
  const prevKey = process.env.POLYMARKET_PRIVATE_KEY;
  const prevAddr = process.env.POLYMARKET_WALLET_ADDRESS;
  delete process.env.POLYMARKET_PRIVATE_KEY;
  delete process.env.POLYMARKET_WALLET_ADDRESS;
  const spy = spyOn(walletStore, 'readWalletFile').mockImplementation(() => null);
  resetWalletIdentityCache();
  try {
    return fn();
  } finally {
    spy.mockRestore();
    if (prevKey === undefined) delete process.env.POLYMARKET_PRIVATE_KEY;
    else process.env.POLYMARKET_PRIVATE_KEY = prevKey;
    if (prevAddr === undefined) delete process.env.POLYMARKET_WALLET_ADDRESS;
    else process.env.POLYMARKET_WALLET_ADDRESS = prevAddr;
    resetWalletIdentityCache();
  }
}

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
      expect(octagonUnavailableMessage(COMMAND_FEATURE[cmd]!, cmd)).toContain('not available for Polymarket');
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

  test('portfolio is wallet-gated, not Octagon-gated', () => {
    // It reads an account, so it needs an address — but not a key, and not
    // anything Octagon provides.
    expect(isTradingCommand('portfolio')).toBe(true);
    expect(isDeferredCommand('portfolio')).toBe(false);
  });

  test('availability follows wallet state rather than a fixed list', () => {
    withNoWallet(() => {
      // No wallet: an account view would be all zeros, indistinguishable from a
      // real empty account, so it stays hidden.
      expect(isCommandAvailable('portfolio')).toBe(false);
      for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(false);

      // Watch tier: reads work, anything needing a signature still does not.
      process.env.POLYMARKET_WALLET_ADDRESS = '0x' + '1'.repeat(40);
      resetWalletIdentityCache();
      expect(isCommandAvailable('portfolio')).toBe(true);
      for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(false);

      // Trade tier: everything opens up.
      delete process.env.POLYMARKET_WALLET_ADDRESS;
      process.env.POLYMARKET_PRIVATE_KEY = '0x' + '11'.repeat(32);
      resetWalletIdentityCache();
      for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(true);
      expect(isCommandAvailable('portfolio')).toBe(true);
    });
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

  test('overview hides what the current wallet state cannot run', () => {
    withNoWallet(() => {
      const text = overview();
      // With no wallet that is still every trading command, but now because the
      // wallet is absent rather than because a list says so.
      for (const cmd of [...DEFERRED_COMMANDS, ...TRADING_COMMANDS]) {
        expect(text).not.toMatch(new RegExp(`^\\s{2}${cmd}\\b`, 'm'));
      }
      // `wallet` is how you get out of that state, so it must always be listed.
      expect(text).toMatch(/^\s{2}wallet\b/m);
    });
  });

  test('overview still lists the commands that work', () => {
    const text = overview();
    // `status` earns its place here: it used to be reachable only as
    // `portfolio status`, and gating portfolio would otherwise bury it.
    for (const cmd of ['search', 'analyze', 'watch', 'backtest', 'status']) {
      expect(text).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });

  test('a gated topic returns only why it cannot run', () => {
    const r = buildHelp('cli', 'clusters');
    expect('text' in r).toBe(true);
    if ('text' in r) {
      expect(r.text.startsWith('`clusters` is not available')).toBe(true);
      // No reference block: its syntax belongs to a venue this tool does not trade.
      expect(r.text).not.toContain('Reference');
    }
  });

  test('no user-facing help text names another venue or its tickers', () => {
    const surfaces = ['cli', 'slash'] as const;
    for (const ctx of surfaces) {
      const overview = buildHelp(ctx);
      const text = 'text' in overview ? overview.text : '';
      expect(text).not.toMatch(/kalshi/i);
      expect(text).not.toMatch(/\bKX[A-Z0-9-]{2,}/);
    }
    for (const cmd of [...DEFERRED_COMMANDS, ...TRADING_COMMANDS]) {
      const r = buildHelp('cli', cmd);
      const text = 'text' in r ? r.text : r.error;
      expect(text).not.toMatch(/kalshi/i);
      expect(text).not.toMatch(/\bKX[A-Z0-9-]{2,}/);
    }
  });

  test('help carries no Kalshi ticker examples', () => {
    const text = overview();
    expect(text).not.toMatch(/\bKX[A-Z0-9-]+/);
  });
});
