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
import {
  checkApprovals,
  pendingApprovals,
  readyToTrade,
  type ApprovalKind,
} from '../chain/approvals.js';
import { auditTrail } from '../audit/index.js';
import { theme } from '../theme.js';

export interface ApprovalRow {
  target: string;
  kind: ApprovalKind;
  approved: boolean;
  required: boolean;
  note?: string;
  error?: string;
}

export interface WalletData {
  action: 'import' | 'address' | 'show' | 'approvals';
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
  approvals?: ApprovalRow[];
  pendingCount?: number;
  /** Missing grants that trading does not need. Reported, never auto-sent. */
  optionalPendingCount?: number;
  readyToTrade?: boolean;
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


/**
 * Report the on-chain grants trading needs. Read-only, free, no gas.
 *
 * There is no send counterpart. Polymarket grants these during onboarding —
 * verified against a live account, which arrived 7/7 without this CLI touching
 * it — and the only routing we could have implemented went through the type-1
 * proxy factory, which cannot serve the deposit wallets new accounts get. So
 * this reports, and polymarket.com fixes.
 */
async function approvalsHandler(): Promise<CLIResponse<WalletData>> {
  const id = loadWalletIdentity();
  if (!id.address) return wrapError('wallet', 'NO_WALLET', NO_WALLET_MESSAGE);

  const statuses = await checkApprovals(id.address);
  const pending = pendingApprovals(statuses);

  return wrapSuccess('wallet', {
    action: 'approvals',
    readyToTrade: readyToTrade(statuses),
    optionalPendingCount: pendingApprovals(statuses, true).length - pending.length,
    tier: id.tier,
    address: id.address,
    signer: id.signer,
    pendingCount: pending.length,
    approvals: statuses.map((a) => ({
      target: a.target,
      kind: a.kind,
      approved: a.approved,
      required: a.required,
      ...(a.note ? { note: a.note } : {}),
      ...(a.error ? { error: a.error } : {}),
    })),
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
      case 'approvals':
        return await approvalsHandler();
      case 'approve':
        return wrapError(
          'wallet',
          'MOVED',
          'This CLI does not send approvals. Polymarket grants them when you first trade on ' +
            'polymarket.com. Run `polymarket wallet approvals` to see their state.',
        );
      case 'address':
        return addressHandler();
      case 'show':
      case undefined:
        return await showHandler();
      default:
        return wrapError(
          'wallet',
          'UNKNOWN_SUB',
          `Unknown subcommand: ${sub}. Try: import, address, show, approvals.`,
        );
    }
  } catch (err) {
    return wrapError('wallet', 'WALLET_ERROR', err instanceof Error ? err.message : String(err));
  }
}

export function formatWalletHuman(data: WalletData): string {
  const lines: string[] = [];

  if (data.action === 'approvals') {
    lines.push('  Trading approvals');
    lines.push('');

    const mark = (a: ApprovalRow) =>
      a.error
        ? theme.error('  ?   ') // unreadable: NOT the same as unapproved
        : a.approved
          ? theme.success('  OK  ')
          : theme.muted('  --  ');
    const label = (a: ApprovalRow) => `${a.kind === 'collateral' ? 'pUSD' : 'CTF '} → ${a.target}`;

    const rows = data.approvals ?? [];
    for (const a of rows.filter((r) => r.required)) {
      lines.push(`${mark(a)}${label(a)}${a.error ? theme.muted('  could not read') : ''}`);
    }

    // Listed separately, because showing these alongside the required ones made
    // a wallet that trades perfectly well report four outstanding approvals.
    const optional = rows.filter((r) => !r.required);
    if (optional.length > 0) {
      lines.push('');
      lines.push(theme.muted('  Optional — not needed to trade:'));
      for (const a of optional) {
        lines.push(`${mark(a)}${label(a)}${a.note ? theme.muted(`   ${a.note}`) : ''}`);
      }
    }

    lines.push('');
    if (data.message) {
      lines.push(theme.muted(`    ${data.message}`));
    } else if ((data.pendingCount ?? 0) > 0) {
      lines.push(
        theme.muted(`    ${data.pendingCount} required grant(s) missing. Polymarket grants these when`),
      );
      lines.push(theme.muted('    you first trade on polymarket.com — do it there, then re-run this.'));
    } else if (data.readyToTrade) {
      lines.push(theme.success('    Ready to trade — every required approval is in place.'));
      if ((data.optionalPendingCount ?? 0) > 0) {
        lines.push(
          theme.muted(
            `    ${data.optionalPendingCount} optional grant(s) not set. Only needed to split, merge or`,
          ),
        );
        lines.push(theme.muted('    redeem positions directly, which this CLI does not do.'));
      }
    }
    return lines.join('\n');
  }

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
