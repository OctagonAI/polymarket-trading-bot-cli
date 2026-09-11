/**
 * Persistence for the Polymarket wallet.
 *
 * The private key lives here and NOT in the shared `.env`, for two reasons that
 * are both about blast radius:
 *
 *  - `ENV_PATH` (`src/utils/env.ts`) prefers a repo-root `.env` when one exists,
 *    which is precisely the file that gets committed by accident.
 *  - `saveApiKeyToEnv` sets no file mode, so `~/.polymarket-bot/.env` lands at
 *    0644 in a 0755 directory. An API key at 0644 is bad; a signing key at 0644
 *    is a different category of bad.
 *
 * It is also not a `BotConfig` setting: `polymarket config` prints every setting
 * unredacted, `setBotSetting` writes an audit entry containing old and new
 * values, and string settings get no validation at all — so a typo'd funding
 * address would be accepted silently.
 *
 * Every read and write takes an explicit path, defaulting to the app dir. That
 * keeps the permission behaviour testable against a tmpdir without adding an
 * env override to `paths.ts` purely for tests — the same injection shape as
 * `new AuditTrail(filePath?)` and `createDb(':memory:')`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { appPath } from '../utils/paths.js';

export const WALLET_FILE_MODE = 0o600;
export const WALLET_DIR_MODE = 0o700;

/** Only signature type 1 is supported; the field exists so the file is self-describing. */
export type WalletType = 'proxy';

export interface StoredWallet {
  version: 1;
  type: WalletType;
  /** The proxy that holds funds. Always present — this is what gets queried. */
  address: string;
  /** Signing EOA. Absent for a watch-only wallet. */
  signer?: string;
  /** Absent for a watch-only wallet. */
  privateKey?: string;
  createdAt: number;
  /** Unix seconds when `eth_getCode` last confirmed the proxy. */
  verifiedCodeAt?: number;
}

export function walletPath(): string {
  return appPath('wallet.json');
}

export function walletExists(path: string = walletPath()): boolean {
  return existsSync(path);
}

/**
 * Validate an untrusted object into a `StoredWallet`.
 *
 * Throws rather than returning a partial wallet: a file that half-parses would
 * otherwise produce a wallet with no address, and every downstream read would
 * report an empty account instead of a broken config.
 */
export function parseStoredWallet(raw: unknown): StoredWallet {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('wallet file is not a JSON object');
  }
  const w = raw as Record<string, unknown>;

  if (w.version !== 1) throw new Error(`unsupported wallet file version: ${String(w.version)}`);
  if (w.type !== 'proxy') throw new Error(`unsupported wallet type: ${String(w.type)}`);

  const address = typeof w.address === 'string' ? w.address.trim() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`wallet file has no valid address (got ${JSON.stringify(w.address)})`);
  }

  const signer = typeof w.signer === 'string' && w.signer.trim() ? w.signer.trim() : undefined;
  const privateKey =
    typeof w.privateKey === 'string' && w.privateKey.trim() ? w.privateKey.trim() : undefined;

  // A key without a signer address is recoverable (derive it), but a signer
  // without a key is just a watch-only wallet, so neither is fatal.
  return {
    version: 1,
    type: 'proxy',
    address,
    ...(signer ? { signer } : {}),
    ...(privateKey ? { privateKey } : {}),
    createdAt: typeof w.createdAt === 'number' ? w.createdAt : 0,
    ...(typeof w.verifiedCodeAt === 'number' ? { verifiedCodeAt: w.verifiedCodeAt } : {}),
  };
}

/** Returns null when no wallet file exists; throws when one exists but is unusable. */
export function readWalletFile(path: string = walletPath()): StoredWallet | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Could not read wallet file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parseStoredWallet(parsed);
  } catch (err) {
    throw new Error(`Invalid wallet file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write the wallet with owner-only permissions.
 *
 * `chmodSync` runs unconditionally after the write because the `mode` option is
 * ignored when the file already exists — without it, a wallet first written by
 * an older build would keep its original permissions forever.
 */
export function writeWalletFile(wallet: StoredWallet, path: string = walletPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: WALLET_DIR_MODE });
  writeFileSync(path, `${JSON.stringify(wallet, null, 2)}\n`, { mode: WALLET_FILE_MODE });
  try {
    chmodSync(path, WALLET_FILE_MODE);
    chmodSync(dir, WALLET_DIR_MODE);
  } catch {
    // Windows and some network filesystems have no POSIX modes. The write
    // succeeded; refusing here would be worse than the weaker permissions.
  }
}
