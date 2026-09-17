/**
 * Shape checks for the two hex strings the wallet path accepts.
 *
 * Deliberately just validators. What used to live here — CREATE2 derivation of
 * a proxy wallet from its signing EOA — is gone: the funder address cannot be
 * computed offline for the wallets this CLI now supports, because which
 * derivation applies depends on on-chain state. The SDK resolves it once at
 * import and the answer is stored. See `src/wallet/account.ts`.
 */
export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isPrivateKey(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

/** Normalise a hex key to the `0x`-prefixed form viem expects. */
export function normalizePrivateKey(value: string): `0x${string}` {
  const raw = value.trim().replace(/^0x/i, '');
  return `0x${raw.toLowerCase()}`;
}
