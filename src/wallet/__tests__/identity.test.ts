import { describe, test, expect } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveIdentity, type IdentityEnv } from '../identity.js';
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
    expect(resolveIdentity({}, null)).toEqual({ tier: 'none', source: 'none' });
  });

  test('a saved key is unaffected by an environment address', () => {
    // The address is a read-only override for inspecting another account.
    // Letting it redirect a wallet that can sign would read one account while
    // trading another.
    const id = resolveIdentity(
      { POLYMARKET_WALLET_ADDRESS: OTHER },
      fileWallet({ signer: SIGNER_A, privateKey: KEY_A }),
    );
    expect(id).toMatchObject({ tier: 'trade', address: SAVED, source: 'file' });
  });

  test('a stored key gives trading, and carries the resolved wallet type', () => {
    const id = resolveIdentity({}, fileWallet({ signer: SIGNER_A, privateKey: KEY_A }));
    expect(id.tier).toBe('trade');
    expect(id.address).toBe(SAVED);
    expect(id.walletType).toBe('deposit');
    expect(id.source).toBe('file');
  });

  test('an address alone gives watch, from either source', () => {
    expect(resolveIdentity({ POLYMARKET_WALLET_ADDRESS: OTHER }, null)).toMatchObject({
      tier: 'watch',
      address: OTHER,
      source: 'env-address',
    });
    expect(resolveIdentity({}, fileWallet())).toMatchObject({ tier: 'watch', source: 'file' });
  });

  test('a stored key outranks a watch-only env address', () => {
    const id = resolveIdentity(
      { POLYMARKET_WALLET_ADDRESS: OTHER } as IdentityEnv,
      fileWallet({ signer: SIGNER_A, privateKey: KEY_A }),
    );
    expect(id.tier).toBe('trade');
  });

  test('an older account type resolves like any other', () => {
    // Accounts made on polymarket.com before deposit wallets existed are
    // proxies or Safes. Polymarket still reports them, so they still load.
    const id = resolveIdentity({}, fileWallet({ type: 'proxy', signer: SIGNER_A, privateKey: KEY_A }));
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
});
