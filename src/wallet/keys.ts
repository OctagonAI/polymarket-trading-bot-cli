/**
 * Shape checks for the two hex strings the wallet path accepts.
 *
 * Deliberately just validators. What used to live here — CREATE2 derivation of
 * a proxy wallet from its signing EOA — is gone: the funder address cannot be
 * computed offline for the wallets this CLI now supports, because which
 * derivation applies depends on on-chain state. The SDK resolves it once at
 * import and the answer is stored. See `src/wallet/account.ts`.
 */
import { isAddress as isChecksummedAddress } from 'viem';

/**
 * A well-formed address, checksum included.
 *
 * This used to be a bare `/^0x[0-9a-fA-F]{40}$/`, on the assumption that
 * `getAddress` downstream would reject a bad EIP-55 checksum. It does not: viem
 * calls its own `isAddress(address, { strict: false })` — shape only — and then
 * *recomputes* the casing, so a mistyped address was accepted and silently
 * rewritten into a valid-looking one. The user then watched an account that was
 * not theirs, which reads as an empty portfolio rather than as a typo.
 *
 * Checking the checksum is the whole point of EIP-55, and it is the only
 * protection available here: an address is a bare 20-byte number, so every
 * typo lands on another address that exists. An all-lowercase address carries
 * no checksum and is accepted as-is; a mixed-case one must match.
 */
export function isAddress(value: string): boolean {
  return isChecksummedAddress(value.trim());
}

export function isPrivateKey(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

/** Normalise a hex key to the `0x`-prefixed form viem expects. */
export function normalizePrivateKey(value: string): `0x${string}` {
  const raw = value.trim().replace(/^0x/i, '');
  return `0x${raw.toLowerCase()}`;
}
