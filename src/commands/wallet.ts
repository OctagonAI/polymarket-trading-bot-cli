/**
 * `wallet` — create, import and inspect the Polymarket wallet.
 *
 * Nothing here moves funds or signs anything. It manages a keypair and reports
 * what the chain says about the derived proxy.
 */
import * as readline from 'node:readline';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import type { ParsedArgs } from './parse-args.js';
import { wrapSuccess, wrapError, type CLIResponse } from './json.js';
import {
  readWalletFile,
  writeWalletFile,
  walletPath,
  walletExists,
  type StoredWallet,
} from '../wallet/store.js';
import {
  deriveProxyAddress,
  isAddress,
  isPrivateKey,
  normalizePrivateKey,
  verifyProxyOnChain,
  type ProxyCodeStatus,
} from '../wallet/proxy.js';
import {
  loadWalletIdentity,
  resetWalletIdentityCache,
  loadPrivateKey,
  type WalletTier,
} from '../wallet/identity.js';
import {
  checkApprovals,
  pendingApprovals,
  buildApprovalBatch,
  PROXY_FACTORY,
  type ApprovalKind,
} from '../chain/approvals.js';
import { estimateFees, signAndSend, waitForReceipt, polBalance, formatPol } from '../chain/tx.js';
import { auditTrail } from '../audit/index.js';
import { theme } from '../theme.js';

export interface ApprovalRow {
  target: string;
  kind: ApprovalKind;
  approved: boolean;
  error?: string;
}

export interface WalletData {
  action: 'create' | 'import' | 'address' | 'show' | 'approve';
  tier: WalletTier;
  /** Proxy address — the one that holds funds. */
  address?: string;
  /** Signing EOA. */
  signer?: string;
  source?: string;
  configPath?: string;
  /** Only ever populated by `create`, and only for the one-time display. */
  privateKey?: string;
  proxyStatus?: ProxyCodeStatus;
  proxyStatusError?: string;
  /** Env and saved wallet disagree about which account to use. */
  conflict?: string;
  /** POL held by the signing EOA — this is who pays gas. */
  polBalance?: string;
  approvals?: ApprovalRow[];
  pendingCount?: number;
  estimatedGasPol?: string;
  txHash?: string;
  sent?: boolean;
  message?: string;
}

/** Chain lookup is best-effort: unreachable means unknown, never means wrong. */
async function checkProxy(address: string): Promise<Pick<WalletData, 'proxyStatus' | 'proxyStatusError'>> {
  try {
    const { status } = await verifyProxyOnChain(address);
    return { proxyStatus: status };
  } catch (err) {
    return { proxyStatusError: err instanceof Error ? err.message : String(err) };
  }
}

function persist(wallet: StoredWallet): void {
  writeWalletFile(wallet);
  resetWalletIdentityCache();
}

async function createHandler(force: boolean): Promise<CLIResponse<WalletData>> {
  if (walletExists() && !force) {
    return wrapError(
      'wallet',
      'WALLET_EXISTS',
      `A wallet already exists at ${walletPath()}. Move or delete it first, or pass --force to replace it. ` +
        `Replacing a funded wallet without its private key backed up loses the funds.`,
    );
  }

  const privateKey = generatePrivateKey();
  const signer = privateKeyToAccount(privateKey).address;
  const address = deriveProxyAddress(signer);

  persist({
    version: 1,
    type: 'proxy',
    address,
    signer,
    privateKey,
    createdAt: Math.floor(Date.now() / 1000),
  });

  return wrapSuccess('wallet', {
    action: 'create',
    tier: 'trade',
    address,
    signer,
    privateKey,
    configPath: walletPath(),
    message: 'Back up the private key now. It is not recoverable from anywhere else.',
  });
}

async function importHandler(
  value: string | undefined,
  force: boolean,
  proxyOverride?: string,
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
    const signer = privateKeyToAccount(privateKey).address;
    // --proxy exists because derivation is the one step that can be silently
    // wrong; a user who knows their deposit address can pin it.
    const address = proxyOverride ? getAddress(proxyOverride) : deriveProxyAddress(signer);
    persist({
      version: 1,
      type: 'proxy',
      address,
      signer,
      privateKey,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return wrapSuccess('wallet', {
      action: 'import',
      tier: 'trade',
      address,
      signer,
      configPath: walletPath(),
      ...(await checkProxy(address)),
    });
  }

  if (isAddress(trimmed)) {
    // A pasted address is the PROXY, not the EOA: that is what the Polymarket
    // UI shows as the deposit address and what the Data API returns as
    // `proxyWallet`. Deriving from it would produce a real-looking address that
    // has never held anything.
    const address = getAddress(trimmed);
    persist({ version: 1, type: 'proxy', address, createdAt: Math.floor(Date.now() / 1000) });
    return wrapSuccess('wallet', {
      action: 'import',
      tier: 'watch',
      address,
      configPath: walletPath(),
      message: 'Read-only: balances and positions work, trading needs a private key.',
      ...(await checkProxy(address)),
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
    configPath: walletPath(),
    ...(id.conflict ? { conflict: id.conflict } : {}),
    ...(id.signer ? { polBalance: await polBalance(id.signer).then(formatPol).catch(() => undefined) } : {}),
    ...(id.address ? await checkProxy(id.address) : {}),
  });
}


/** Grants needed for trading, as a plain row list. Read-only, free, no gas. */
async function approveCheckHandler(): Promise<CLIResponse<WalletData>> {
  const id = loadWalletIdentity();
  if (!id.address) return wrapError('wallet', 'NO_WALLET', NO_WALLET_MESSAGE);

  const statuses = await checkApprovals(id.address);
  const pending = pendingApprovals(statuses);

  return wrapSuccess('wallet', {
    action: 'approve',
    tier: id.tier,
    address: id.address,
    signer: id.signer,
    sent: false,
    pendingCount: pending.length,
    approvals: statuses.map((a) => ({
      target: a.target,
      kind: a.kind,
      approved: a.approved,
      ...(a.error ? { error: a.error } : {}),
    })),
    ...(id.signer ? { polBalance: formatPol(await polBalance(id.signer)) } : {}),
  });
}

/** Ask before spending. Returns false unless the answer is an explicit yes. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function approveHandler(args: ParsedArgs): Promise<CLIResponse<WalletData>> {
  if (args.check) return approveCheckHandler();

  const id = loadWalletIdentity();
  if (!id.address) return wrapError('wallet', 'NO_WALLET', NO_WALLET_MESSAGE);
  if (id.tier !== 'trade' || !id.signer) {
    return wrapError(
      'wallet',
      'WATCH_ONLY',
      `This wallet is watch-only (${id.address}). Approvals are on-chain transactions signed by your ` +
        'key. Run `polymarket wallet import <private-key> --force` first.',
    );
  }

  const statuses = await checkApprovals(id.address);
  const unreadable = statuses.filter((s) => s.error);
  if (unreadable.length > 0) {
    return wrapError(
      'wallet',
      'CHECK_FAILED',
      `Could not read ${unreadable.length} of ${statuses.length} approvals, so it is not clear what ` +
        `needs granting: ${unreadable[0]!.error}. Sending blind could pay gas for grants already in place.`,
    );
  }

  const pending = pendingApprovals(statuses);
  if (pending.length === 0) {
    return wrapSuccess('wallet', {
      action: 'approve',
      tier: id.tier,
      address: id.address,
      signer: id.signer,
      sent: false,
      pendingCount: 0,
      approvals: statuses.map((a) => ({ target: a.target, kind: a.kind, approved: a.approved })),
      message: 'Everything is already approved. Nothing to send.',
    });
  }

  // estimateGas executes against current state, so a batch that would revert
  // fails here — before the user is asked to approve anything.
  const data = buildApprovalBatch(pending);
  let fees;
  try {
    fees = await estimateFees(id.signer, PROXY_FACTORY, data);
  } catch (err) {
    return wrapError(
      'wallet',
      'ESTIMATE_FAILED',
      `Could not estimate gas, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const balance = await polBalance(id.signer);
  if (balance < fees.maxCostWei) {
    return wrapError(
      'wallet',
      'INSUFFICIENT_GAS',
      `Not enough POL for gas. Signing wallet ${id.signer} holds ${formatPol(balance)} POL, and this ` +
        `needs up to ${formatPol(fees.maxCostWei)} POL. Send POL (not pUSD) to that address — it is the ` +
        'signing wallet, not the funding wallet.',
    );
  }

  const gasPol = formatPol(fees.maxCostWei);
  if (!args.yes) {
    const lines = [
      '',
      '  These are on-chain transactions. Gas is paid in POL from your signing',
      '  wallet — a real cost, and it is not refundable.',
      '',
      `  Signing wallet   ${id.signer}   ${formatPol(balance)} POL`,
      `  Funding wallet   ${id.address}   (holds your pUSD)`,
      `  Estimated gas    up to ${gasPol} POL      Network  Polygon (137)`,
      '',
      `  ${pending.length} grant(s) to send, ${statuses.length - pending.length} already in place:`,
      ...pending.map((g) => `    ${g.kind === 'collateral' ? 'pUSD' : 'CTF '} → ${g.target}`),
      '',
    ];
    console.log(lines.join('\n'));
    if (!(await confirm('  Send these transactions? [y/N] '))) {
      return wrapError('wallet', 'CANCELLED', 'Cancelled. Nothing was sent.');
    }
  }

  const key = loadPrivateKey();
  if (!key) return wrapError('wallet', 'NO_KEY', 'No private key available to sign with.');

  const tx = await signAndSend(key, PROXY_FACTORY, data, fees);
  const receipt = await waitForReceipt(tx.hash);

  auditTrail.log({
    type: 'APPROVAL_SENT',
    wallet: id.address,
    tx_hash: tx.hash,
    grants: pending.map((g) => `${g.target}:${g.kind}`),
    gas_used: receipt.gasUsed.toString(),
    success: receipt.success,
  });

  if (!receipt.success) {
    return wrapError(
      'wallet',
      'TX_REVERTED',
      `Transaction ${tx.hash} was mined but reverted. Gas was spent and nothing was approved.`,
    );
  }

  // Re-read rather than assume: the point of the check is that it is authoritative.
  const after = await checkApprovals(id.address);
  return wrapSuccess('wallet', {
    action: 'approve',
    tier: id.tier,
    address: id.address,
    signer: id.signer,
    sent: true,
    txHash: tx.hash,
    estimatedGasPol: gasPol,
    pendingCount: pendingApprovals(after).length,
    approvals: after.map((a) => ({ target: a.target, kind: a.kind, approved: a.approved })),
  });
}

export const NO_WALLET_MESSAGE =
  'No wallet configured. Run `polymarket wallet create` for a new one, or ' +
  '`polymarket wallet import <private-key|address>` to bring your own.';

export async function handleWallet(args: ParsedArgs): Promise<CLIResponse<WalletData>> {
  const sub = args.positionalArgs[0]?.toLowerCase();
  const rest = args.positionalArgs.slice(1);

  try {
    switch (sub) {
      case 'create':
        return await createHandler(args.force);
      case 'import':
        return await importHandler(rest[0], args.force, args.proxy);
      case 'approve':
        return await approveHandler(args);
      case 'address':
        return addressHandler();
      case 'show':
      case undefined:
        return await showHandler();
      default:
        return wrapError(
          'wallet',
          'UNKNOWN_SUB',
          `Unknown subcommand: ${sub}. Try: create, import, address, show, approve.`,
        );
    }
  } catch (err) {
    return wrapError('wallet', 'WALLET_ERROR', err instanceof Error ? err.message : String(err));
  }
}

const PROXY_STATUS_TEXT: Record<ProxyCodeStatus, string> = {
  undeployed: 'not deployed yet (normal until the first on-chain action)',
  confirmed: 'confirmed on-chain',
  foreign: 'WARNING: code at this address is not a Polymarket proxy',
};

export function formatWalletHuman(data: WalletData): string {
  const lines: string[] = [];

  if (data.action === 'approve') {
    lines.push(data.sent ? theme.success('  Approvals sent.') : '  Trading approvals');
    lines.push('');
    for (const a of data.approvals ?? []) {
      const label = `${a.kind === 'collateral' ? 'pUSD' : 'CTF '} → ${a.target}`;
      const mark = a.error
        ? theme.error('  ?   ') // unreadable: NOT the same as unapproved
        : a.approved
          ? theme.success('  OK  ')
          : theme.muted('  --  ');
      lines.push(`${mark}${label}${a.error ? theme.muted('  could not read') : ''}`);
    }
    lines.push('');
    if (data.txHash) {
      lines.push(`    Transaction  ${data.txHash}`);
      if (data.estimatedGasPol) lines.push(`    Gas budget   up to ${data.estimatedGasPol} POL`);
    }
    if (data.polBalance !== undefined) {
      lines.push(`    Signing wallet POL  ${data.polBalance}`);
    }
    if (data.message) {
      lines.push(theme.muted(`    ${data.message}`));
    } else if ((data.pendingCount ?? 0) > 0) {
      lines.push(
        theme.muted(`    ${data.pendingCount} grant(s) outstanding. Send them with: polymarket wallet approve`),
      );
      lines.push(theme.muted('    Gas is paid in POL from the signing wallet.'));
    } else if (!data.sent) {
      lines.push(theme.muted('    All approvals in place — this wallet can trade once orders ship.'));
    }
    return lines.join('\n');
  }

  if (data.action === 'create') {
    lines.push(theme.success('  Wallet created.'));
    lines.push('');
    lines.push(`    Signing wallet   ${data.signer}`);
    lines.push(`    Funding wallet   ${data.address}  ${theme.muted('(deposit here)')}`);
    lines.push('');
    lines.push(theme.error('    Private key      ') + data.privateKey);
    lines.push(theme.error('    Back this up now — it is not recoverable from anywhere else.'));
    lines.push('');
    lines.push(theme.muted(`    Saved to ${data.configPath}`));
    return lines.join('\n');
  }

  if (data.action === 'address') {
    return data.address ?? '';
  }

  lines.push('  Wallet');
  lines.push('');
  lines.push(`    Funding wallet   ${data.address}  ${theme.muted('(holds pUSD)')}`);
  if (data.signer) {
    const pol = data.polBalance !== undefined ? theme.muted(`  ${data.polBalance} POL (gas)`) : '';
    lines.push(`    Signing wallet   ${data.signer}${pol}`);
  }
  lines.push(`    Mode             ${data.tier === 'trade' ? 'trading' : 'read-only'}`);
  if (data.source) lines.push(`    Key source       ${data.source}`);
  if (data.configPath) lines.push(`    Config           ${data.configPath}`);

  if (data.proxyStatus) {
    const text = PROXY_STATUS_TEXT[data.proxyStatus];
    lines.push(
      `    Proxy            ${data.proxyStatus === 'foreign' ? theme.error(text) : theme.muted(text)}`,
    );
  } else if (data.proxyStatusError) {
    lines.push(`    Proxy            ${theme.muted('could not check — ' + data.proxyStatusError)}`);
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
