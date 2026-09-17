import { describe, test, expect } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveIdentity } from '../identity.js';
import { isAddress, isPrivateKey, normalizePrivateKey } from '../keys.js';
import type { StoredWallet } from '../store.js';

/**
 * `resolveIdentity` is pure, so the whole precedence table is testable without
 * touching disk, env, or network.
 */

const KEY_A = `0x${'11'.repeat(32)}`;
const SIGNER_A = privateKeyToAccount(KEY_A as `0x${string}`).address;
const SAVED = '0x18eD5C15CeD1bFdf88e701601C4a0BbD4F5142dE';
const OTHER = '0x1111111111111111111111111111111111111111';

function fileWallet(overrides: Partial<StoredWallet> = {}): StoredWallet {
  return { version: 1, type: 'deposit', address: SAVED, createdAt: 0, ...overrides };
}

describe('tier resolution', () => {
  test('nothing configured is tier none', () => {
    expect(resolveIdentity(null)).toEqual({ tier: 'none', source: 'none' });
  });

  test('a stored key gives trading, and carries the resolved wallet type', () => {
    const id = resolveIdentity(fileWallet({ signer: SIGNER_A, privateKey: KEY_A }));
    expect(id.tier).toBe('trade');
    expect(id.address).toBe(SAVED);
    expect(id.walletType).toBe('deposit');
    expect(id.source).toBe('file');
  });

  test('an address alone gives watch', () => {
    expect(resolveIdentity(fileWallet())).toMatchObject({
      tier: 'watch',
      address: SAVED,
      source: 'file',
    });
  });

  test('the saved wallet is the only way in', () => {
    // The environment cannot supply an identity. `source` has exactly two
    // values left, and neither is an env var: a wallet came from the file or
    // there is no wallet. Reintroducing an override means reintroducing a
    // `WalletSource`, which this assertion fails on.
    const sources = [resolveIdentity(null).source, resolveIdentity(fileWallet()).source];
    expect(sources).toEqual(['none', 'file']);
  });

  test('an older account type resolves like any other', () => {
    // Accounts made on polymarket.com before deposit wallets existed are
    // proxies or Safes. Polymarket still reports them, so they still load.
    const id = resolveIdentity(fileWallet({ type: 'proxy', signer: SIGNER_A, privateKey: KEY_A }));
    expect(id.tier).toBe('trade');
    expect(id.walletType).toBe('proxy');
  });
});

describe('input recognition', () => {
  test('keys are accepted with or without the 0x prefix', () => {
    expect(isPrivateKey('a'.repeat(64))).toBe(true);
    expect(isPrivateKey(`0x${'a'.repeat(64)}`)).toBe(true);
    expect(normalizePrivateKey('A'.repeat(64))).toBe(`0x${'a'.repeat(64)}`);
  });

  test('an address is not mistaken for a key, or vice versa', () => {
    expect(isPrivateKey(OTHER)).toBe(false);
    expect(isAddress(OTHER)).toBe(true);
    expect(isAddress(`0x${'a'.repeat(64)}`)).toBe(false);
  });

  test('an address whose checksum does not match is rejected', () => {
    // The point of EIP-55. Every 40-hex string is *some* address, so a typo
    // cannot be caught by shape — only by the capitalisation the checksum
    // encodes. Accepting this one would have the user reading an account that
    // is not theirs, which looks exactly like an empty portfolio.
    const typo = `${SAVED.slice(0, -1)}${SAVED.endsWith('E') ? 'e' : 'E'}`;
    expect(typo).toHaveLength(42);
    expect(typo).not.toBe(SAVED);
    expect(isAddress(typo)).toBe(false);
  });

  test('a checksummed address is accepted, in either allowed casing', () => {
    // Mixed case must match the checksum; all-lowercase carries no checksum at
    // all and is the form a user gets from a block explorer's "copy" button.
    expect(isAddress(SAVED)).toBe(true);
    expect(isAddress(SAVED.toLowerCase())).toBe(true);
    expect(isAddress(`  ${SAVED}  `)).toBe(true);
  });
});
