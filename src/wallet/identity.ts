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
 */
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { readWalletFile, type StoredWallet, type WalletType } from './store.js';
import { isAddress, isPrivateKey, normalizePrivateKey } from './keys.js';
import { logger } from '../utils/logger.js';

export type WalletTier = 'none' | 'watch' | 'trade';

export type WalletSource = 'env-key' | 'env-address' | 'file' | 'none';

export interface WalletIdentity {
  tier: WalletTier;
  /** Funding address — what holds funds and what the Data API is queried with. */
  address?: string;
  /** Signing EOA. Only present at tier `trade`. */
  signer?: string;
  /** What kind of contract the funder is. Only known for a saved wallet. */
  walletType?: WalletType;
  source: WalletSource;
  /** Set when the env and the wallet file disagree about which account to use. */
  conflict?: string;
}

export interface IdentityEnv {
  POLYMARKET_PRIVATE_KEY?: string;
  POLYMARKET_WALLET_ADDRESS?: string;
}

/**
 * Resolve a tier from inputs. Pure: no disk, no network, no cache.
 *
 * Precedence is env over file, and the env key wins *wholesale* rather than
 * merging with the file — a half-merged identity (this file's address, that
 * env's key) would sign with one account and read another.
 *
 * An environment key carries no funding address. Which contract holds the money
 * for a given signer is not computable offline, so there is nothing honest to
 * put there: `POLYMARKET_WALLET_ADDRESS` supplies it, or `wallet import` does
 * the resolution once and saves it. Signing still works without it — the CLOB
 * client resolves its own wallet — but reads have no account to query.
 */
export function resolveIdentity(env: IdentityEnv, file: StoredWallet | null): WalletIdentity {
  const envKey = env.POLYMARKET_PRIVATE_KEY?.trim();
  const envAddress = env.POLYMARKET_WALLET_ADDRESS?.trim();
  const envFunder = envAddress && isAddress(envAddress) ? getAddress(envAddress) : undefined;

  if (envKey) {
    if (!isPrivateKey(envKey)) {
      // Never echo the value.
      logger.warn('POLYMARKET_PRIVATE_KEY is not a 32-byte hex key; ignoring it');
    } else {
      const signer = privateKeyToAccount(normalizePrivateKey(envKey)).address;
      const conflict = envFunder
        ? file && file.address.toLowerCase() !== envFunder.toLowerCase()
          ? `POLYMARKET_WALLET_ADDRESS is ${envFunder}, but the saved wallet is ${file.address}. Using the environment.`
          : undefined
        : 'POLYMARKET_PRIVATE_KEY is set without POLYMARKET_WALLET_ADDRESS, so balances and positions ' +
          'have no account to read. Set it, or run `polymarket wallet import <private-key>`.';
      return {
        tier: 'trade',
        ...(envFunder ? { address: envFunder } : {}),
        signer,
        source: 'env-key',
        ...(conflict ? { conflict } : {}),
      };
    }
  }

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
  if (cached.conflict) logger.warn(cached.conflict);
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
  const envKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  if (envKey && isPrivateKey(envKey)) return normalizePrivateKey(envKey);
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
