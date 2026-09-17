/**
 * Which wallet this process is operating as, and how much it may do.
 *
 * Three tiers, because the two capabilities are genuinely separable:
 *
 *   none  — no wallet. Research and market data only.
 *   watch — an address, no key. Balances, positions and P&L are readable;
 *           nothing can be signed.
 *   trade — a key. Everything.
 *
 * `watch` exists because the address a user pastes from the Polymarket UI is
 * enough to read an account, and requiring a private key to look at your own
 * portfolio would be a bad trade for the user.
 *
 * Key material is deliberately NOT a field on `WalletIdentity`. The identity
 * object is passed around, logged, and spread into JSON; a key on it would leak
 * the first time someone added a debug line. `loadPrivateKey()` is a separate,
 * explicit call.
 *
 * There is no environment override for either the signing key or the address.
 * Both existed. The key could pair an environment key with the *saved* wallet's
 * cached CLOB credentials — authenticating as one account with another's
 * credentials, then writing the session's credentials back over the saved file.
 * The address was harmless by comparison but pulled its weight in confusion: it
 * silently outranked a saved watch-only wallet, so `wallet show` could report an
 * account the user had never imported, and nothing on screen said where the
 * address came from. A wallet now comes from one place. Switching is
 * `wallet import --force` or the setup wizard, both of which resolve the account
 * and save it as a unit.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { readWalletFile, type StoredWallet, type WalletType } from './store.js';
import { isPrivateKey, normalizePrivateKey } from './keys.js';
import { logger } from '../utils/logger.js';

export type WalletTier = 'none' | 'watch' | 'trade';

export type WalletSource = 'file' | 'none';

export interface WalletIdentity {
  tier: WalletTier;
  /** Funding address — what holds funds and what the Data API is queried with. */
  address?: string;
  /** Signing EOA. Only present at tier `trade`. */
  signer?: string;
  /** What kind of contract the funder is. Only known for a saved wallet. */
  walletType?: WalletType;
  source: WalletSource;
}

/**
 * Resolve a tier from the saved wallet. Pure: no disk, no network, no cache.
 *
 * A key gives `trade`, an address alone gives `watch`, and no file at all gives
 * `none`. Taking the file as an argument rather than reading it keeps the whole
 * table testable without touching disk.
 */
export function resolveIdentity(file: StoredWallet | null): WalletIdentity {
  if (file?.privateKey && isPrivateKey(file.privateKey)) {
    const signer = file.signer ?? privateKeyToAccount(normalizePrivateKey(file.privateKey)).address;
    return { tier: 'trade', address: file.address, signer, walletType: file.type, source: 'file' };
  }

  if (file) {
    return {
      tier: 'watch',
      address: file.address,
      ...(file.signer ? { signer: file.signer } : {}),
      walletType: file.type,
      source: 'file',
    };
  }

  return { tier: 'none', source: 'none' };
}

let cached: WalletIdentity | null = null;

/**
 * The current identity, cached per process.
 *
 * Never throws. The scan loop calls into this on every pass, and a wallet file
 * that fails to parse must degrade to "no wallet" rather than take down a
 * research session that does not need one.
 */
export function loadWalletIdentity(): WalletIdentity {
  if (cached) return cached;
  let file: StoredWallet | null = null;
  try {
    file = readWalletFile();
  } catch (err) {
    logger.warn(`Ignoring unreadable wallet file: ${err instanceof Error ? err.message : String(err)}`);
  }
  cached = resolveIdentity(file);
  return cached;
}

/** Call after writing a wallet, and in test setup/teardown. */
export function resetWalletIdentityCache(): void {
  cached = null;
}

/**
 * The signing key, or undefined at tiers `none` and `watch`.
 *
 * Separate from `loadWalletIdentity` and uncached on purpose: this is the only
 * function in the codebase that returns key material, which makes it the only
 * one to audit.
 */
export function loadPrivateKey(): `0x${string}` | undefined {
  try {
    const file = readWalletFile();
    if (file?.privateKey && isPrivateKey(file.privateKey)) return normalizePrivateKey(file.privateKey);
  } catch {
    // An unreadable file is "no key", consistent with loadWalletIdentity.
  }
  return undefined;
}

export function hasSigningKey(): boolean {
  return loadWalletIdentity().tier === 'trade';
}
