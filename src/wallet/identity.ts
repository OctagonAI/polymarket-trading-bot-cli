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
 * There is no environment override for the signing key. One existed, and it
 * could pair an environment key with the *saved* wallet's cached CLOB
 * credentials — authenticating as one account with another's credentials, then
 * writing the session's credentials back over the saved file. Switching wallets
 * is `wallet import --force` or the setup wizard, both of which resolve the
 * account and save it as a unit. `POLYMARKET_WALLET_ADDRESS` remains, because
 * an address is read-only and carries no credential to confuse.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { readWalletFile, type StoredWallet, type WalletType } from './store.js';
import { isAddress, isPrivateKey, normalizePrivateKey } from './keys.js';
import { logger } from '../utils/logger.js';

export type WalletTier = 'none' | 'watch' | 'trade';

export type WalletSource = 'env-address' | 'file' | 'none';

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

export interface IdentityEnv {
  POLYMARKET_WALLET_ADDRESS?: string;
}

/**
 * Resolve a tier from inputs. Pure: no disk, no network, no cache.
 *
 * A saved key outranks `POLYMARKET_WALLET_ADDRESS`: the address is a read-only
 * override for inspecting some other account, and letting it silently redirect
 * a wallet that can sign would read one account while trading another.
 */
export function resolveIdentity(env: IdentityEnv, file: StoredWallet | null): WalletIdentity {
  const envAddress = env.POLYMARKET_WALLET_ADDRESS?.trim();
  const envFunder = envAddress && isAddress(envAddress) ? getAddress(envAddress) : undefined;

  if (file?.privateKey && isPrivateKey(file.privateKey)) {
    const signer = file.signer ?? privateKeyToAccount(normalizePrivateKey(file.privateKey)).address;
    return { tier: 'trade', address: file.address, signer, walletType: file.type, source: 'file' };
  }

  if (envFunder) {
    return { tier: 'watch', address: envFunder, source: 'env-address' };
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
  cached = resolveIdentity(process.env as IdentityEnv, file);
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
