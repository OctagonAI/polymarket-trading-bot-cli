import { describe, test, expect } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveIdentity, type IdentityEnv } from '../identity.js';
import { deriveProxyAddress, isAddress, isPrivateKey, normalizePrivateKey, classifyProxyCode, expectedProxyRuntimeCode } from '../proxy.js';
import type { StoredWallet } from '../store.js';

/**
 * `resolveIdentity` is pure, so the whole precedence table is testable without
 * touching disk, env, or network.
 */

const KEY_A = `0x${'11'.repeat(32)}`;
const KEY_B = `0x${'22'.repeat(32)}`;
const SIGNER_A = privateKeyToAccount(KEY_A as `0x${string}`).address;
const PROXY_A = deriveProxyAddress(SIGNER_A);
const PROXY_B = deriveProxyAddress(privateKeyToAccount(KEY_B as `0x${string}`).address);
const OTHER = '0x1111111111111111111111111111111111111111';

function fileWallet(overrides: Partial<StoredWallet> = {}): StoredWallet {
  return { version: 1, type: 'proxy', address: PROXY_B, createdAt: 0, ...overrides };
}

describe('tier resolution', () => {
  test('nothing configured is tier none', () => {
    expect(resolveIdentity({}, null)).toEqual({ tier: 'none', source: 'none' });
  });

  test('an env key gives trading, with the proxy derived from it', () => {
    const id = resolveIdentity({ POLYMARKET_PRIVATE_KEY: KEY_A }, null);
    expect(id.tier).toBe('trade');
    expect(id.signer).toBe(SIGNER_A);
    expect(id.address).toBe(PROXY_A);
    expect(id.source).toBe('env-key');
  });

  test('a stored key gives trading', () => {
    const id = resolveIdentity({}, fileWallet({ signer: SIGNER_A, privateKey: KEY_A }));
    expect(id.tier).toBe('trade');
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

  test('the env key wins wholesale and reports the disagreement', () => {
    // Merging the file's address with the env's key would sign as one account
    // and read balances from another.
    const id = resolveIdentity({ POLYMARKET_PRIVATE_KEY: KEY_A }, fileWallet());
    expect(id.address).toBe(PROXY_A);
    expect(id.address).not.toBe(PROXY_B);
    expect(id.conflict).toContain(PROXY_B);
  });

  test('no conflict is reported when env and file agree', () => {
    const id = resolveIdentity({ POLYMARKET_PRIVATE_KEY: KEY_A }, fileWallet({ address: PROXY_A }));
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
    expect(id.address).toBe(PROXY_B);
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

describe('proxy derivation and code check', () => {
  test('derivation is deterministic and is not the signing address', () => {
    expect(deriveProxyAddress(SIGNER_A)).toBe(PROXY_A);
    // Reading a balance at the EOA returns zero for every funded account, so
    // conflating the two is a silent money bug.
    expect(PROXY_A.toLowerCase()).not.toBe(SIGNER_A.toLowerCase());
  });

  test('different signers derive different proxies', () => {
    expect(PROXY_A).not.toBe(PROXY_B);
  });

  test('code classification separates undeployed, confirmed and foreign', () => {
    const impl = '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f';
    expect(classifyProxyCode('0x', impl)).toBe('undeployed');
    expect(classifyProxyCode('', impl)).toBe('undeployed');
    expect(classifyProxyCode(expectedProxyRuntimeCode(impl), impl)).toBe('confirmed');
    // Real leaderboard accounts include Safes and older relay proxies; those
    // must report as foreign rather than be assumed good.
    expect(classifyProxyCode('0xdeadbeef', impl)).toBe('foreign');
  });

  test('the expected runtime code is an EIP-1167 clone of the implementation', () => {
    const impl = '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f';
    const code = expectedProxyRuntimeCode(impl);
    expect(code.startsWith('0x363d3d373d3d3d363d73')).toBe(true);
    expect(code).toContain(impl.slice(2).toLowerCase());
    expect(code.endsWith('5af43d82803e903d91602b57fd5bf3')).toBe(true);
  });
});
