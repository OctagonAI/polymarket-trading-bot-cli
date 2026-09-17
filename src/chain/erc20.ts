/**
 * pUSD — Polymarket's collateral token.
 *
 * pUSD is a USDC-backed ERC-20 on Polygon, and it is what a funded account
 * actually holds: sampled live accounts carry pUSD and exactly zero USDC.e.
 * Code that reads USDC.e (as pre-2026 Polymarket bots do) returns 0.00 for
 * every current account.
 *
 * A balance is `number | null`, never a coerced 0. `null` means "could not
 * read" — no wallet, or an unreachable RPC — and callers must keep that
 * distinct from an account that is genuinely empty. Collapsing the two is what
 * made a failed read look like a total loss in the drawdown maths.
 */
import { encodeFunctionData, decodeFunctionResult, erc20Abi, getAddress } from 'viem';
import { ethCall } from './rpc.js';

export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
export const PUSD_DECIMALS = 6;
export const PUSD_SYMBOL = 'pUSD';

/**
 * Short TTL so a burst of reads costs one RPC call.
 *
 * `analyze` with N tickers sizes each one, and every sizing reads the balance;
 * without this, a batch of 50 is 50 identical calls against a public endpoint
 * that will eventually rate-limit. Short enough that a balance change shows up
 * within a few seconds.
 */
const BALANCE_TTL_MS = 10_000;

let cache: { address: string; value: number; at: number } | null = null;

export function resetBalanceCache(): void {
  cache = null;
}

/** Convert a uint256 in token base units to a float, at 6 decimals. */
export function fromPusdUnits(raw: bigint): number {
  return Number(raw) / 10 ** PUSD_DECIMALS;
}

/**
 * Free pUSD held by an address, or null if it could not be read.
 *
 * Throws nothing: every failure path returns null so a research session never
 * dies on an unreachable RPC. Callers that want the reason should call
 * `ethCall` directly.
 */
export async function readPusdBalance(owner: string): Promise<number | null> {
  const address = getAddress(owner);

  const hit = cache;
  if (hit && hit.address === address && Date.now() - hit.at < BALANCE_TTL_MS) {
    return hit.value;
  }

  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    const raw = await ethCall(PUSD_ADDRESS, data);
    if (!raw || raw === '0x') return null;
    const decoded = decodeFunctionResult({
      abi: erc20Abi,
      functionName: 'balanceOf',
      data: raw as `0x${string}`,
    });
    const value = fromPusdUnits(decoded as bigint);
    cache = { address, value, at: Date.now() };
    return value;
  } catch {
    // Unreachable or gated RPC. Unknown, not zero.
    return null;
  }
}
