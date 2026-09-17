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
 * The account wallet is left to the SDK. `createSecureClient` resolves the
 * funder for a signer and reports it back as `client.account`, which is what
 * makes deposit wallets work: the signer is an EOA with no money, the funder is
 * the contract that holds the pUSD, and the order signature type has to match
 * whichever kind of wallet that turns out to be. Hard-coding it — as this file
 * did for the proxy — silently signs for an account that does not hold funds.
 */
import { createSecureClient, type SecureClient, type ApiKeyCreds } from '@polymarket/client';
import { privateKey as privateKeySigner } from '@polymarket/client/viem';
import { loadWalletIdentity, loadPrivateKey } from '../wallet/identity.js';
import { readWalletFile, writeWalletFile } from '../wallet/store.js';
import { logger } from '../utils/logger.js';

export class ClobAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClobAuthError';
  }
}

function cachedCreds(): ApiKeyCreds | undefined {
  try {
    const file = readWalletFile();
    const c = file?.apiCreds;
    // The wallet file stores plain strings; the SDK brands its key type. The
    // cast is the boundary — invalid creds fall back to a fresh handshake.
    return c?.key && c.secret && c.passphrase ? (c as unknown as ApiKeyCreds) : undefined;
  } catch {
    return undefined;
  }
}

function cacheCreds(creds: ApiKeyCreds): void {
  try {
    const file = readWalletFile();
    if (!file) return;
    if (
      file.apiCreds?.key === creds.key &&
      file.apiCreds.secret === creds.secret &&
      file.apiCreds.passphrase === creds.passphrase
    ) {
      return;
    }
    writeWalletFile({ ...file, apiCreds: creds });
  } catch (err) {
    // Caching is an optimisation; failing to do it must not fail the command.
    logger.warn(`Could not cache CLOB credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Authenticating costs a round trip and, without cached creds, a signature.
// `buildOrder` and `postOrder` each ask for a client, so one per process.
let clientPromise: Promise<SecureClient> | null = null;

/**
 * An authenticated client, deriving and caching L2 credentials on first use.
 *
 * Throws `ClobAuthError` rather than a bare library error, so callers can tell
 * "this wallet cannot authenticate" apart from "the CLOB is down".
 */
export async function getClobClient(): Promise<SecureClient> {
  const id = loadWalletIdentity();
  if (id.tier !== 'trade') {
    throw new ClobAuthError(
      id.tier === 'watch'
        ? `This wallet is watch-only (${id.address}). Orders need a private key: polymarket wallet import <private-key> --force`
        : 'No wallet configured. Run `polymarket wallet import <private-key>`.',
    );
  }

  const key = loadPrivateKey();
  if (!key) throw new ClobAuthError('No private key available to authenticate with.');

  clientPromise ??= (async () => {
    const creds = cachedCreds();
    const client = await createSecureClient({
      signer: privateKeySigner(key),
      ...(creds ? { credentials: creds } : {}),
    });
    cacheCreds(client.credentials);
    return client;
  })().catch((err) => {
    // A failed handshake must not poison every later call in the process.
    clientPromise = null;
    throw new ClobAuthError(
      `Could not authenticate with the CLOB as ${id.signer ?? 'the configured signer'}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return clientPromise;
}

/** Drop cached L2 creds so the next call re-derives them. */
export function clearCachedCreds(): void {
  clientPromise = null;
  try {
    const file = readWalletFile();
    if (!file?.apiCreds) return;
    const { apiCreds: _drop, ...rest } = file;
    writeWalletFile(rest);
  } catch {
    // Nothing to clear if the file cannot be read.
  }
}
