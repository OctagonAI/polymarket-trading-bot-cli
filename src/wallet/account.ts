/**
 * Asking Polymarket which wallet a private key actually controls.
 *
 * A Polymarket account is two addresses: the **signer**, an EOA that holds no
 * money and pays gas, and the **wallet** — the contract that holds the pUSD and
 * the outcome tokens. Which contract that is depends on when and how the
 * account was created, and the three kinds are derived differently.
 *
 * This cannot be computed offline. Deposit wallets have two derivations and
 * which one applies turns on whether the factory is deployed, so the SDK reads
 * chain state to decide. That is why resolution happens once, at import, and
 * the answer is written to the wallet file: every later command reads an
 * address from disk instead of paying a round trip to learn its own identity.
 *
 * Getting this wrong is the expensive mistake in the whole wallet path. A wrong
 * funder address is not an error — it is a real, empty account, and it looks
 * exactly like an account you have not funded yet.
 */
import { createSecureClient, WalletType as SdkWalletType } from '@polymarket/client';
import { privateKey as privateKeySigner } from '@polymarket/client/viem';
import type { WalletType } from './store.js';

export interface ResolvedAccount {
  /** The EOA that signs. Pays gas; holds nothing. */
  signer: string;
  /** The contract that holds the funds. What balances are read against. */
  address: string;
  walletType: WalletType;
  /** L2 credentials, so the first trade does not pay for a second handshake. */
  apiCreds: { key: string; secret: string; passphrase: string };
}

export class AccountResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountResolutionError';
  }
}

const WALLET_TYPES: Record<number, WalletType> = {
  [SdkWalletType.EOA]: 'eoa',
  [SdkWalletType.POLY_PROXY]: 'proxy',
  [SdkWalletType.GNOSIS_SAFE]: 'safe',
  [SdkWalletType.DEPOSIT_WALLET]: 'deposit',
};

/** Human wording for `wallet show` and the import confirmation. */
export const WALLET_TYPE_LABEL: Record<WalletType, string> = {
  deposit: 'Deposit wallet — what polymarket.com creates',
  proxy: 'Proxy wallet — an older Polymarket account',
  safe: 'Gnosis Safe — an older Polymarket account',
  eoa: 'EOA — the signing key itself holds the funds',
};

/**
 * Resolve the account for a signing key.
 *
 * Authenticates in the process, which is how the wallet is resolved at all, and
 * returns the credentials so they can be cached alongside the address.
 */
export async function resolveAccount(privateKey: `0x${string}`): Promise<ResolvedAccount> {
  let client;
  try {
    client = await createSecureClient({ signer: privateKeySigner(privateKey) });
  } catch (err) {
    throw new AccountResolutionError(
      `Could not reach Polymarket to resolve this key's wallet: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const { signer, wallet, walletType } = client.account;
  const type = WALLET_TYPES[walletType as number];
  if (!type) {
    throw new AccountResolutionError(`Polymarket reported an unknown wallet type (${String(walletType)}).`);
  }

  const creds = client.credentials;
  return {
    signer,
    address: wallet,
    walletType: type,
    apiCreds: { key: String(creds.key), secret: creds.secret, passphrase: creds.passphrase },
  };
}
