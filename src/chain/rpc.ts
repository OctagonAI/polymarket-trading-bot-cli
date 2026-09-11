/**
 * Minimal read-only JSON-RPC client for Polygon.
 *
 * Deliberately not viem's `createPublicClient`. viem's transport carries its own
 * retry, timeout and batching stack, which would make chain reads the only
 * network path in this CLI not governed by `fetchWithDeadline` — and the reason
 * that helper exists is that an unread response body hangs silently, which here
 * would freeze the scan loop on every pass. viem is used purely as an ABI codec
 * and for key handling.
 *
 * Public Polygon RPCs are progressively being gated: `polygon-rpc.com` answers
 * `tenant disabled` and Ankr now demands a key. A gated endpoint MUST surface as
 * an error rather than as a zero balance — a silently-empty read that looks like
 * real data is the failure mode this codebase has already been bitten by once.
 */
import { fetchWithDeadline, isAbortError, safeText } from '../utils/http.js';

/** Matches `polymarket-cli`'s default, and verified reachable unauthenticated. */
export const DEFAULT_RPC_URL = 'https://polygon.drpc.org';

/** Used only in the error message, to give a stuck user somewhere to go. */
export const FALLBACK_RPC_URL = 'https://1rpc.io/matic';

export const POLYGON_CHAIN_ID = 137;

const RPC_TIMEOUT_MS = 10_000;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function rpcUrl(): string {
  return process.env.POLYMARKET_RPC_URL?.trim() || DEFAULT_RPC_URL;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One JSON-RPC call. Throws `RpcError` for transport, HTTP and JSON-RPC-level
 * failures alike — callers that want to degrade gracefully catch it and say the
 * value is unknown, never that it is zero.
 */
export async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const url = rpcUrl();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  try {
    return await fetchWithDeadline(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      RPC_TIMEOUT_MS,
      async (resp) => {
        if (!resp.ok) {
          const text = (await safeText(resp)).slice(0, 200);
          throw new RpcError(
            `Polygon RPC ${url} returned ${resp.status} ${resp.statusText}${text ? `: ${text}` : ''}. ` +
              `Set POLYMARKET_RPC_URL to another endpoint (e.g. ${FALLBACK_RPC_URL}).`,
            method,
          );
        }
        const json = (await resp.json()) as JsonRpcResponse;
        if (json.error) {
          throw new RpcError(
            `Polygon RPC error on ${method}: ${json.error.message ?? 'unknown'}. ` +
              `Set POLYMARKET_RPC_URL to another endpoint (e.g. ${FALLBACK_RPC_URL}).`,
            method,
          );
        }
        return json.result;
      },
    );
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (isAbortError(err)) {
      throw new RpcError(`Polygon RPC ${url} timed out after ${RPC_TIMEOUT_MS}ms`, method, err);
    }
    throw new RpcError(
      `Could not reach Polygon RPC ${url}: ${err instanceof Error ? err.message : String(err)}`,
      method,
      err,
    );
  }
}

/** Deployed bytecode at an address. `'0x'` means nothing is deployed there. */
export async function ethGetCode(address: string): Promise<string> {
  const result = await rpcCall('eth_getCode', [address, 'latest']);
  return typeof result === 'string' ? result : '0x';
}

/** Raw `eth_call` return data. */
export async function ethCall(to: string, data: string): Promise<string> {
  const result = await rpcCall('eth_call', [{ to, data }, 'latest']);
  return typeof result === 'string' ? result : '0x';
}

/** Native POL balance in wei, as a bigint. */
export async function ethGetBalance(address: string): Promise<bigint> {
  const result = await rpcCall('eth_getBalance', [address, 'latest']);
  return typeof result === 'string' ? BigInt(result) : 0n;
}
