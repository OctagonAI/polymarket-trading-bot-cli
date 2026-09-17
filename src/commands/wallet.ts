/**
 * `wallet` — import and inspect the Polymarket wallet.
 *
 * There is no `create`. A wallet generated here would be a fresh account with
 * no Polymarket history, and the account that matters is the one the user
 * already made on polymarket.com: that is where their money is, and it is the
 * only one the site will deposit into. So the way in is to import that key.
 *
 * Nothing here moves funds. `approve` is the one subcommand that signs.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import type { ParsedArgs } from './parse-args.js';
import { wrapSuccess, wrapError, type CLIResponse } from './json.js';
import {
  readWalletFile,
  writeWalletFile,
  walletPath,
  walletExists,
  type StoredWallet,
  type WalletType,
} from '../wallet/store.js';
import { isAddress, isPrivateKey, normalizePrivateKey } from '../wallet/keys.js';
import { resolveAccount, AccountResolutionError, WALLET_TYPE_LABEL } from '../wallet/account.js';
import {
  loadWalletIdentity,
  resetWalletIdentityCache,
  loadPrivateKey,
  type WalletTier,
} from '../wallet/identity.js';
import { auditTrail } from '../audit/index.js';
import { theme } from '../theme.js';

export interface WalletData {
  action: 'import' | 'address' | 'show';
  tier: WalletTier;
  /** Funding address — the one that holds funds. */
  address?: string;
  /** Signing EOA. */
  signer?: string;
  /** What Polymarket says the funding contract is. Unknown for a pasted address. */
  walletType?: WalletType;
  source?: string;
  configPath?: string;
  /** Env and saved wallet disagree about which account to use. */
  conflict?: string;
  message?: string;
}

function persist(wallet: StoredWallet): void {
  writeWalletFile(wallet);
  resetWalletIdentityCache();
}

async function importHandler(
  value: string | undefined,
  force: boolean,
): Promise<CLIResponse<WalletData>> {
  if (!value) {
    return wrapError(
      'wallet',
      'MISSING_ARG',
      'Usage: wallet import <private-key|address>. A private key enables trading; an address alone is read-only.',
    );
  }
  if (walletExists() && !force) {
    return wrapError(
      'wallet',
      'WALLET_EXISTS',
      `A wallet already exists at ${walletPath()}. Pass --force to replace it.`,
    );
  }

  const trimmed = value.trim();

  if (isPrivateKey(trimmed)) {
    const privateKey = normalizePrivateKey(trimmed);
    // Which contract holds the funds is not derivable offline, so ask
    // Polymarket once and record the answer. Guessing here produces a real,
    // empty address that is indistinguishable from an unfunded account.
    let account;
    try {
      account = await resolveAccount(privateKey);
    } catch (err) {
      if (err instanceof AccountResolutionError) {
        return wrapError('wallet', 'RESOLVE_FAILED', err.message);
      }
      throw err;
    }
    persist({
      version: 1,
      type: account.walletType,
      address: account.address,
      signer: account.signer,
      privateKey,
      createdAt: Math.floor(Date.now() / 1000),
      apiCreds: account.apiCreds,
    });
    return wrapSuccess('wallet', {
      action: 'import',
      tier: 'trade',
      address: account.address,
      signer: account.signer,
      walletType: account.walletType,
      configPath: walletPath(),
    });
  }

  if (isAddress(trimmed)) {
    // A pasted address is the FUNDING wallet, not the signing EOA: that is what
    // polymarket.com shows and what the Data API returns as `proxyWallet`.
    // Nothing is resolved here, so no wallet type is claimed.
    const address = getAddress(trimmed);
    persist({ version: 1, address, createdAt: Math.floor(Date.now() / 1000) });
    return wrapSuccess('wallet', {
      action: 'import',
      tier: 'watch',
      address,
      configPath: walletPath(),
      message: 'Read-only: balances and positions work, trading needs a private key.',
    });
  }

  return wrapError(
    'wallet',
    'INVALID_ARG',
    `Not a private key or an address: ${trimmed.length > 12 ? `${trimmed.slice(0, 6)}…` : trimmed}. ` +
      'Expected 64 hex characters (private key) or 0x + 40 hex characters (address).',
  );
}

function addressHandler(): CLIResponse<WalletData> {
  const id = loadWalletIdentity();
  if (id.tier === 'none') {
    return wrapError('wallet', 'NO_WALLET', NO_WALLET_MESSAGE);
  }
  return wrapSuccess('wallet', { action: 'address', tier: id.tier, address: id.address });
}

async function showHandler(): Promise<CLIResponse<WalletData>> {
  const id = loadWalletIdentity();
  if (id.tier === 'none') {
    return wrapError('wallet', 'NO_WALLET', NO_WALLET_MESSAGE);
  }
  return wrapSuccess('wallet', {
    action: 'show',
    tier: id.tier,
    address: id.address,
    signer: id.signer,
    source: id.source,
    ...(id.walletType ? { walletType: id.walletType } : {}),
    configPath: walletPath(),
    ...(id.conflict ? { conflict: id.conflict } : {}),
  });
}


export const NO_WALLET_MESSAGE =
  'No wallet configured. Create an account on polymarket.com, then run ' +
  '`polymarket wallet import <private-key>`. An address alone works for read-only use.';

export async function handleWallet(args: ParsedArgs): Promise<CLIResponse<WalletData>> {
  const sub = args.positionalArgs[0]?.toLowerCase();
  const rest = args.positionalArgs.slice(1);

  try {
    switch (sub) {
      case 'import':
        return await importHandler(rest[0], args.force);
      case 'address':
        return addressHandler();
      case 'show':
      case undefined:
        return await showHandler();
      default:
        return wrapError(
          'wallet',
          'UNKNOWN_SUB',
          `Unknown subcommand: ${sub}. Try: import, address, show.`,
        );
    }
  } catch (err) {
    return wrapError('wallet', 'WALLET_ERROR', err instanceof Error ? err.message : String(err));
  }
}

export function formatWalletHuman(data: WalletData): string {
  const lines: string[] = [];

  if (data.action === 'address') {
    return data.address ?? '';
  }

  lines.push('  Wallet');
  lines.push('');
  lines.push(`    Funding wallet   ${data.address}  ${theme.muted('(holds pUSD)')}`);
  if (data.signer) {
    lines.push(`    Signing wallet   ${data.signer}`);
  }
  lines.push(`    Mode             ${data.tier === 'trade' ? 'trading' : 'read-only'}`);
  if (data.source) lines.push(`    Key source       ${data.source}`);
  if (data.configPath) lines.push(`    Config           ${data.configPath}`);

  if (data.walletType) {
    lines.push(`    Wallet type      ${theme.muted(WALLET_TYPE_LABEL[data.walletType])}`);
  }

  // logger.warn only buffers for the TUI, so a conflict would otherwise be
  // invisible in CLI mode — and signing as a different account than the one
  // saved is precisely what a user needs told.
  if (data.conflict) {
    lines.push('');
    lines.push(theme.error(`    ${data.conflict}`));
  }
  if (data.message) {
    lines.push('');
    lines.push(theme.muted(`    ${data.message}`));
  }
  if (data.tier === 'watch') {
    lines.push(theme.muted('    Trading needs a private key: polymarket wallet import <key> --force'));
  }
  return lines.join('\n');
}
