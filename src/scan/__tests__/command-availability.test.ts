import { describe, test, expect, spyOn } from 'bun:test';
import {
  TRADING_COMMANDS,
  KEY_COMMANDS,
  isTradingCommand,
  isCommandAvailable,
} from '../../tools/polymarket/polymarket-trade.js';
import { resetWalletIdentityCache } from '../../wallet/identity.js';
import * as walletStore from '../../wallet/store.js';
import { buildHelp } from '../../commands/help.js';

/**
 * Run `fn` with no wallet visible.
 *
 * The store is the only source of one, and `loadWalletIdentity` reads
 * ~/.polymarket-bot/wallet.json, so without this stub these assertions pass or
 * fail depending on whether the developer running them has a wallet.
 */
function withNoWallet<T>(fn: () => T): T {
  const spy = spyOn(walletStore, 'readWalletFile').mockImplementation(() => null);
  resetWalletIdentityCache();
  try {
    return fn();
  } finally {
    spy.mockRestore();
    resetWalletIdentityCache();
  }
}

describe('command availability', () => {
  test('portfolio is wallet-gated', () => {
    // It reads an account, so it needs an address — but not a key.
    expect(isTradingCommand('portfolio')).toBe(true);
    expect(isCommandAvailable('search')).toBe(true);
  });

  test('availability follows wallet state rather than a fixed list', () => {
    withNoWallet(() => {
      // No wallet: an account view would be all zeros, indistinguishable from a
      // real empty account, so it stays hidden.
      expect(isCommandAvailable('portfolio')).toBe(false);
      for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(false);

      // Watch tier: reads work, anything needing a signature still does not.
      const watching = spyOn(walletStore, 'readWalletFile').mockImplementation(() => ({
        version: 1 as const,
        address: '0x18eD5C15CeD1bFdf88e701601C4a0BbD4F5142dE',
        createdAt: 0,
      }));
      resetWalletIdentityCache();
      expect(isCommandAvailable('portfolio')).toBe(true);
      for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(false);
      watching.mockRestore();

      // Trade tier: everything opens up. A saved wallet is the only way to any
      // tier — the environment cannot supply a key or an address.
      const saved = spyOn(walletStore, 'readWalletFile').mockImplementation(() => ({
        version: 1 as const,
        type: 'deposit' as const,
        address: '0x' + '2'.repeat(40),
        signer: '0x' + '3'.repeat(40),
        privateKey: '0x' + '11'.repeat(32),
        createdAt: 0,
      }));
      resetWalletIdentityCache();
      try {
        for (const cmd of KEY_COMMANDS) expect(isCommandAvailable(cmd)).toBe(true);
        expect(isCommandAvailable('portfolio')).toBe(true);
      } finally {
        saved.mockRestore();
        resetWalletIdentityCache();
      }
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

describe('help reflects the wallet gate', () => {
  const overview = () => {
    const r = buildHelp('cli');
    return 'text' in r ? r.text : '';
  };

  test('overview hides what the current wallet state cannot run', () => {
    withNoWallet(() => {
      const text = overview();
      // With no wallet that is still every trading command, but now because the
      // wallet is absent rather than because a list says so.
      for (const cmd of TRADING_COMMANDS) {
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

  test('no user-facing help text names another venue or its tickers', () => {
    const surfaces = ['cli', 'slash'] as const;
    for (const ctx of surfaces) {
      const overview = buildHelp(ctx);
      const text = 'text' in overview ? overview.text : '';
      expect(text).not.toMatch(/kalshi/i);
      expect(text).not.toMatch(/\bKX[A-Z0-9-]{2,}/);
    }
    for (const cmd of [...TRADING_COMMANDS, 'search', 'similar', 'events', 'catalysts', 'trust', 'report']) {
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
