/**
 * `wallet` — create, import and inspect the Polymarket wallet.
 *
 * Nothing here moves funds or signs anything. It manages a keypair and reports
 * what the chain says about the derived proxy.
 */
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
import { loadWalletIdentity, resetWalletIdentityCache, type WalletTier } from '../wallet/identity.js';
import { theme } from '../theme.js';

export interface WalletData {
  action: 'create' | 'import' | 'address' | 'show';
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
    ...(id.address ? await checkProxy(id.address) : {}),
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
      case 'address':
        return addressHandler();
      case 'show':
      case undefined:
        return await showHandler();
      default:
        return wrapError(
          'wallet',
          'UNKNOWN_SUB',
          `Unknown subcommand: ${sub}. Try: create, import, address, show.`,
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
  if (data.signer) lines.push(`    Signing wallet   ${data.signer}`);
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
