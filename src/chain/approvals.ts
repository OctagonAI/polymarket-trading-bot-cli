/**
 * The allowances a Polymarket proxy wallet needs, and which of them are
 * actually required to trade.
 *
 * Six contracts, each needing permission to move your pUSD, and five of those
 * additionally needing operator rights over your outcome tokens (ERC-1155) so a
 * sale can transfer them. Eleven grants in total. Addresses match
 * `Polymarket/polymarket-cli` at v0.1.4, which grants all eleven unconditionally.
 *
 * **They are not all required.** Surveying twelve accounts from the volume
 * leaderboard: all twelve hold the seven exchange-side grants, and only four
 * hold the four collateral-adapter grants. The adapters' deployed bytecode
 * exposes exactly three functions — `splitPosition`, `mergePositions` and
 * `redeemPositions` — so they are the collateral path for minting, merging and
 * redeeming complete sets, not the order-matching path. CLOB orders settle
 * peer-to-peer in outcome tokens through the two exchange contracts.
 *
 * So the adapters are marked optional. Reporting them as outstanding on a
 * wallet that trades perfectly well is a false alarm, and acting on it costs
 * real gas for a capability the user may never use.
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
  /** False for grants that trading does not need. See the module comment. */
  required: boolean;
  /** Shown next to an optional grant so "missing" does not read as "broken". */
  note?: string;
}

const SPLIT_MERGE_REDEEM = 'only for split / merge / redeem';

export const APPROVAL_TARGETS: ApprovalTarget[] = [
  { name: 'CTF Exchange', address: '0xE111180000d2663C0091e4f400237545B87B996B', collateral: true, ctfOperator: true, required: true },
  { name: 'Neg Risk Exchange', address: '0xe2222d279d744050d28e00520010520000310F59', collateral: true, ctfOperator: true, required: true },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', collateral: true, ctfOperator: true, required: true },
  { name: 'Conditional Tokens', address: CONDITIONAL_TOKENS, collateral: true, ctfOperator: false, required: true },
  { name: 'CTF Collateral Adapter', address: '0xADa100874d00e3331D00F2007a9c336a65009718', collateral: true, ctfOperator: true, required: false, note: SPLIT_MERGE_REDEEM },
  { name: 'Neg Risk CTF Collateral Adapter', address: '0xAdA200001000ef00D07553cEE7006808F895c6F1', collateral: true, ctfOperator: true, required: false, note: SPLIT_MERGE_REDEEM },
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
  required: boolean;
  note?: string;
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
        const base = {
        target: t.name,
        kind: 'collateral' as const,
        spender: t.address,
        required: t.required,
        ...(t.note ? { note: t.note } : {}),
      };
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
        const base = {
        target: t.name,
        kind: 'ctf' as const,
        spender: t.address,
        required: t.required,
        ...(t.note ? { note: t.note } : {}),
      };
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

/**
 * Grants still needed: not already in place, and not unknown because a read
 * failed.
 *
 * Optional ones are excluded unless `includeOptional` is set, so the default
 * `wallet approve` grants what trading needs and nothing more. Sending the
 * other four costs gas for split/merge/redeem, which most users never touch
 * directly.
 */
export function pendingApprovals(
  statuses: ApprovalStatus[],
  includeOptional = false,
): ApprovalStatus[] {
  return statuses.filter(
    (s) => !s.approved && !s.error && (includeOptional || s.required),
  );
}

/** True when every grant trading actually needs is in place. */
export function readyToTrade(statuses: ApprovalStatus[]): boolean {
  return statuses.filter((s) => s.required).every((s) => s.approved);
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
