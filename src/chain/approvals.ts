/**
 * The allowances Polymarket needs before a proxy wallet can trade.
 *
 * Six contracts, each needing permission to move your pUSD, and five of those
 * additionally needing operator rights over your outcome tokens (ERC-1155) so a
 * sale can transfer them. Eleven grants in total. Addresses match
 * `Polymarket/polymarket-cli` at v0.1.4.
 *
 * Two properties worth stating because they are what make this safe to automate:
 *
 *  - Checking is free and read-only — eleven `eth_call`s, no signature, no gas.
 *    Nothing here sends anything unless `buildApprovalBatch` output is signed
 *    and submitted by the caller.
 *  - Approvals are granted BY THE PROXY, not by the signing EOA. They are
 *    therefore routed through the factory's `proxy()` entry point, where the
 *    sub-call's `msg.sender` is the proxy. Approving from the EOA would appear
 *    to succeed and leave trading just as broken.
 */
import { encodeFunctionData, decodeFunctionResult, erc20Abi, getAddress, maxUint256, parseAbi } from 'viem';
import { ethCall } from './rpc.js';
import { PUSD_ADDRESS, fromPusdUnits } from './erc20.js';
import { PROXY_FACTORY } from '../wallet/proxy.js';

export const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

export interface ApprovalTarget {
  name: string;
  address: string;
  /** Needs an ERC-20 allowance over pUSD. */
  collateral: boolean;
  /** Needs ERC-1155 operator rights over conditional tokens. */
  ctfOperator: boolean;
}

export const APPROVAL_TARGETS: ApprovalTarget[] = [
  { name: 'CTF Exchange', address: '0xE111180000d2663C0091e4f400237545B87B996B', collateral: true, ctfOperator: true },
  { name: 'Neg Risk Exchange', address: '0xe2222d279d744050d28e00520010520000310F59', collateral: true, ctfOperator: true },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', collateral: true, ctfOperator: true },
  { name: 'Conditional Tokens', address: CONDITIONAL_TOKENS, collateral: true, ctfOperator: false },
  { name: 'CTF Collateral Adapter', address: '0xADa100874d00e3331D00F2007a9c336a65009718', collateral: true, ctfOperator: true },
  { name: 'Neg Risk CTF Collateral Adapter', address: '0xAdA200001000ef00D07553cEE7006808F895c6F1', collateral: true, ctfOperator: true },
];

const ctfAbi = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
]);

const proxyAbi = parseAbi([
  'struct ProxyCall { uint8 typeCode; address to; uint256 value; bytes data; }',
  'function proxy(ProxyCall[] calls) payable returns (bytes[])',
]);

export type ApprovalKind = 'collateral' | 'ctf';

export interface ApprovalStatus {
  target: string;
  kind: ApprovalKind;
  /** Contract the grant is made to. */
  spender: string;
  approved: boolean;
  /** pUSD allowance, for collateral grants. null when it could not be read. */
  allowance: number | null;
  /** Set when the check itself failed, so "unapproved" is not assumed. */
  error?: string;
}

/**
 * Read every grant. Eleven `eth_call`s, concurrent, no signature, no gas.
 *
 * A failed read is reported as an error on that row rather than as `approved:
 * false` — sending an approval that is already in place wastes gas, and
 * reporting "not approved" for an unreachable RPC would invite exactly that.
 */
export async function checkApprovals(proxyAddress: string): Promise<ApprovalStatus[]> {
  const owner = getAddress(proxyAddress);
  const checks: Array<() => Promise<ApprovalStatus>> = [];

  for (const t of APPROVAL_TARGETS) {
    if (t.collateral) {
      checks.push(async () => {
        const base = { target: t.name, kind: 'collateral' as const, spender: t.address };
        try {
          const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner, getAddress(t.address)],
          });
          const raw = await ethCall(PUSD_ADDRESS, data);
          const value = decodeFunctionResult({
            abi: erc20Abi,
            functionName: 'allowance',
            data: raw as `0x${string}`,
          }) as bigint;
          return { ...base, approved: value > 0n, allowance: fromPusdUnits(value) };
        } catch (err) {
          return {
            ...base,
            approved: false,
            allowance: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
    }
    if (t.ctfOperator) {
      checks.push(async () => {
        const base = { target: t.name, kind: 'ctf' as const, spender: t.address };
        try {
          const data = encodeFunctionData({
            abi: ctfAbi,
            functionName: 'isApprovedForAll',
            args: [owner, getAddress(t.address)],
          });
          const raw = await ethCall(CONDITIONAL_TOKENS, data);
          const value = decodeFunctionResult({
            abi: ctfAbi,
            functionName: 'isApprovedForAll',
            data: raw as `0x${string}`,
          }) as boolean;
          return { ...base, approved: value, allowance: null };
        } catch (err) {
          return {
            ...base,
            approved: false,
            allowance: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
    }
  }

  return Promise.all(checks.map((fn) => fn()));
}

/** Grants that are neither already in place nor unknown because a read failed. */
export function pendingApprovals(statuses: ApprovalStatus[]): ApprovalStatus[] {
  return statuses.filter((s) => !s.approved && !s.error);
}

/**
 * Calldata for the factory that grants everything in `pending` in one call.
 *
 * Batched rather than sent one transaction at a time as `polymarket-cli` does.
 * One signature, one gas payment, and — the reason that matters — no way to end
 * up half-approved by interrupting it midway, which is a confusing state to
 * diagnose and leaves trading broken in a way that looks like a bug.
 *
 * `typeCode: 1` is a plain CALL. The factory deploys the proxy first if it does
 * not exist yet, so this doubles as the deployment transaction.
 */
export function buildApprovalBatch(pending: ApprovalStatus[]): `0x${string}` {
  const calls = pending.map((s) =>
    s.kind === 'collateral'
      ? {
          typeCode: 1,
          to: getAddress(PUSD_ADDRESS),
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [getAddress(s.spender), maxUint256],
          }),
        }
      : {
          typeCode: 1,
          to: getAddress(CONDITIONAL_TOKENS),
          value: 0n,
          data: encodeFunctionData({
            abi: ctfAbi,
            functionName: 'setApprovalForAll',
            args: [getAddress(s.spender), true],
          }),
        },
  );

  return encodeFunctionData({ abi: proxyAbi, functionName: 'proxy', args: [calls] });
}

export { PROXY_FACTORY };
