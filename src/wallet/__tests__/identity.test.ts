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

  test('an env key alone gives trading but no account to read', () => {
    // Which contract holds the funds is not derivable from the key, so there is
    // nothing honest to put in `address`. Inventing one would name a real,
    // empty account — indistinguishable from an unfunded wallet.
    const id = resolveIdentity({ POLYMARKET_PRIVATE_KEY: KEY_A }, null);
    expect(id.tier).toBe('trade');
    expect(id.signer).toBe(SIGNER_A);
    expect(id.address).toBeUndefined();
    expect(id.source).toBe('env-key');
    expect(id.conflict).toContain('POLYMARKET_WALLET_ADDRESS');
  });

  test('an env key paired with an address is complete and quiet', () => {
    const id = resolveIdentity(
      { POLYMARKET_PRIVATE_KEY: KEY_A, POLYMARKET_WALLET_ADDRESS: OTHER },
      null,
    );
    expect(id).toMatchObject({ tier: 'trade', signer: SIGNER_A, address: OTHER, source: 'env-key' });
    expect(id.conflict).toBeUndefined();
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

  test('the env address wins over the file and reports the disagreement', () => {
    // Reading one account while signing for another is the failure this exists
    // to prevent, so the two must never be merged silently.
    const id = resolveIdentity(
      { POLYMARKET_PRIVATE_KEY: KEY_A, POLYMARKET_WALLET_ADDRESS: OTHER },
      fileWallet(),
    );
    expect(id.address).toBe(OTHER);
    expect(id.conflict).toContain(SAVED);
  });

  test('no conflict is reported when env and file agree', () => {
    const id = resolveIdentity(
      { POLYMARKET_PRIVATE_KEY: KEY_A, POLYMARKET_WALLET_ADDRESS: SAVED },
      fileWallet(),
    );
    expect(id.conflict).toBeUndefined();
  });

  test('a stored key outranks a watch-only env address', () => {
    const id = resolveIdentity(
      { POLYMARKET_WALLET_ADDRESS: OTHER } as IdentityEnv,
      fileWallet({ signer: SIGNER_A, privateKey: KEY_A }),
    );
    expect(id.tier).toBe('trade');
  });

  test('a malformed env key is ignored rather than crashing the session', () => {
    const id = resolveIdentity({ POLYMARKET_PRIVATE_KEY: 'nonsense' }, fileWallet());
    expect(id.tier).toBe('watch');
    expect(id.address).toBe(SAVED);
  });

  test('a legacy proxy wallet file still resolves, and says so', () => {
    // Refusing to load it would brick an existing install over a migration.
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
