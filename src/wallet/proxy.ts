/**
 * Polymarket proxy-wallet derivation, and the runtime check that makes trusting
 * it safe.
 *
 * A Polymarket account has two addresses. The **EOA** is the keypair that signs;
 * the **proxy** is a contract deployed by a factory that actually holds the pUSD
 * and the outcome tokens. It is the proxy that the Data API calls `proxyWallet`,
 * and the proxy that a user sees as their deposit address. Reading a balance at
 * the EOA returns zero for every funded account.
 *
 * The proxy address is CREATE2-derived from the EOA: deterministic, computable
 * offline, and with no on-chain getter (all 13 selectors on the factory were
 * decoded; there is no address→proxy lookup). Derivation is therefore the one
 * place in the wallet path where a silent mistake loses money — a wrong address
 * looks exactly like an empty account.
 *
 * Two mitigations, and neither is optional:
 *
 *  1. Derivation comes from the first-party `@polymarket/sdk` rather than a
 *     hand-rolled CREATE2. The salt and init-code hash are 3KB of literals that
 *     would be transcribed wrong once and then be wrong forever.
 *  2. `classifyProxyCode` checks the deployed bytecode. A live factory proxy is
 *     an EIP-1167 minimal clone of `factory.getImplementation()`, which was
 *     confirmed against real funded accounts. Anything else is reported rather
 *     than assumed good.
 */
import { getAddress, toFunctionSelector } from 'viem';
import { getProxyWalletAddress } from '@polymarket/sdk';
import { ethCall, ethGetCode } from '../chain/rpc.js';

/** Same constant `polymarket-cli` uses for signature type 1. */
export const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const GET_IMPLEMENTATION = toFunctionSelector('function getImplementation() view returns (address)');

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isPrivateKey(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

/** Normalise a hex key to the `0x`-prefixed form viem expects. */
export function normalizePrivateKey(value: string): `0x${string}` {
  const raw = value.trim().replace(/^0x/i, '');
  return `0x${raw.toLowerCase()}`;
}

/** The proxy wallet that holds funds for a signing EOA. */
export function deriveProxyAddress(eoa: string): string {
  return getProxyWalletAddress(PROXY_FACTORY as `0x${string}`, getAddress(eoa));
}

export type ProxyCodeStatus =
  /** Nothing deployed. Normal for a new wallet — the first approval deploys it. */
  | 'undeployed'
  /** An EIP-1167 clone of the factory implementation. Derivation confirmed. */
  | 'confirmed'
  /** Code is present but is not a factory proxy — a Safe, or an older relay proxy. */
  | 'foreign';

/** The runtime bytecode an EIP-1167 clone of `implementation` must have. */
export function expectedProxyRuntimeCode(implementation: string): string {
  return `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase();
}

export function classifyProxyCode(code: string, implementation: string): ProxyCodeStatus {
  const normalized = (code || '0x').toLowerCase();
  if (normalized === '0x' || normalized === '') return 'undeployed';
  return normalized === expectedProxyRuntimeCode(implementation) ? 'confirmed' : 'foreign';
}

/** The implementation the factory currently clones. One `eth_call`. */
export async function fetchProxyImplementation(): Promise<string> {
  const raw = await ethCall(PROXY_FACTORY, GET_IMPLEMENTATION);
  if (!raw || raw.length < 42) {
    throw new Error(`Proxy factory ${PROXY_FACTORY} returned no implementation address`);
  }
  return getAddress(`0x${raw.slice(-40)}`);
}

/**
 * Check a derived proxy against the chain. Two RPC calls.
 *
 * Callers should treat a thrown error as "unknown", never as "wrong" — an
 * unreachable RPC says nothing about whether the address is right.
 */
export async function verifyProxyOnChain(
  proxy: string,
): Promise<{ status: ProxyCodeStatus; implementation: string }> {
  const implementation = await fetchProxyImplementation();
  const code = await ethGetCode(proxy);
  return { status: classifyProxyCode(code, implementation), implementation };
}
