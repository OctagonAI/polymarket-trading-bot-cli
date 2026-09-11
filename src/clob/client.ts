/**
 * Authenticated access to the Polymarket CLOB.
 *
 * Two credentials, layered:
 *
 *  **L1** is the Polygon private key. It signs an EIP-712 message proving
 *  ownership of the signing EOA, and that is used once to obtain L2 creds.
 *
 *  **L2** is an API key/secret/passphrase derived deterministically from L1.
 *  Every subsequent request is HMAC-signed with it. Because it is *derived*
 *  rather than issued, caching it is a convenience rather than an escalation:
 *  anyone holding the key can re-derive it at will. It is cached in the same
 *  0600 wallet file all the same, since it is still a credential.
 *
 * Orders are signed for `SignatureType.POLY_PROXY` with the proxy passed as the
 * funder. That combination is what makes an order settle against the contract
 * that actually holds the pUSD — signing as an EOA would produce a valid
 * signature for an account with no money in it.
 */
import { ClobClient, SignatureType, type ApiKeyCreds } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { loadWalletIdentity, loadPrivateKey } from '../wallet/identity.js';
import { readWalletFile, writeWalletFile } from '../wallet/store.js';
import { getBaseUrl } from '../tools/polymarket/api.js';
import { rpcUrl, POLYGON_CHAIN_ID } from '../chain/rpc.js';
import { logger } from '../utils/logger.js';

export class ClobAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClobAuthError';
  }
}

function walletClientFor(privateKey: `0x${string}`) {
  // A WalletClient is required because clob-client reads `signer.account` and
  // calls `signTypedData` on it; a bare LocalAccount has the latter but not the
  // former. The transport is never exercised for anything we do — signing is
  // local and every CLOB request goes over HTTP inside the client — so this
  // does not route chain reads around `fetchWithDeadline`.
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: polygon,
    transport: http(rpcUrl()),
  });
}

function cachedCreds(): ApiKeyCreds | undefined {
  try {
    const file = readWalletFile();
    const c = file?.apiCreds;
    return c?.key && c.secret && c.passphrase ? c : undefined;
  } catch {
    return undefined;
  }
}

function cacheCreds(creds: ApiKeyCreds): void {
  try {
    const file = readWalletFile();
    if (!file) return;
    writeWalletFile({ ...file, apiCreds: creds });
  } catch (err) {
    // Caching is an optimisation; failing to do it must not fail the command.
    logger.warn(`Could not cache CLOB credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * An authenticated client, deriving and caching L2 credentials on first use.
 *
 * Throws `ClobAuthError` rather than a bare library error, so callers can tell
 * "this wallet cannot authenticate" apart from "the CLOB is down".
 */
export async function getClobClient(): Promise<ClobClient> {
  const id = loadWalletIdentity();
  if (id.tier !== 'trade' || !id.address) {
    throw new ClobAuthError(
      id.tier === 'watch'
        ? `This wallet is watch-only (${id.address}). Orders need a private key: polymarket wallet import <private-key> --force`
        : 'No wallet configured. Run `polymarket wallet create` or `polymarket wallet import <private-key>`.',
    );
  }

  const key = loadPrivateKey();
  if (!key) throw new ClobAuthError('No private key available to authenticate with.');

  const host = getBaseUrl('clob');
  const signer = walletClientFor(key);

  let creds = cachedCreds();
  if (!creds) {
    // Unauthenticated client purely to run the L1 handshake.
    const bootstrap = new ClobClient(host, POLYGON_CHAIN_ID, signer);
    try {
      creds = await bootstrap.createOrDeriveApiKey();
    } catch (err) {
      throw new ClobAuthError(
        `Could not derive CLOB API credentials for ${id.signer}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cacheCreds(creds);
  }

  return new ClobClient(host, POLYGON_CHAIN_ID, signer, creds, SignatureType.POLY_PROXY, id.address);
}

/** Drop cached L2 creds so the next call re-derives them. */
export function clearCachedCreds(): void {
  try {
    const file = readWalletFile();
    if (!file?.apiCreds) return;
    const { apiCreds: _drop, ...rest } = file;
    writeWalletFile(rest);
  } catch {
    // Nothing to clear if the file cannot be read.
  }
}
