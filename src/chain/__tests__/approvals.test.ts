import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { decodeFunctionData, erc20Abi, maxUint256, parseAbi, getAddress } from 'viem';
import * as rpc from '../rpc.js';
import {
  APPROVAL_TARGETS,
  CONDITIONAL_TOKENS,
  checkApprovals,
  pendingApprovals,
  buildApprovalBatch,
  type ApprovalStatus,
} from '../approvals.js';
import { PUSD_ADDRESS } from '../erc20.js';

const OWNER = '0x2c335066fe58fe9237c3d3dc7b275c2a034a0563';
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const TRUE_WORD = `0x${'0'.repeat(63)}1`;
const FALSE_WORD = `0x${'0'.repeat(64)}`;
const MAX_WORD = `0x${'f'.repeat(64)}`;

/** Answer every eth_call by which contract it targets. */
function stubCalls(byContract: (to: string) => string) {
  spies.push(spyOn(rpc, 'ethCall').mockImplementation(async (to: string) => byContract(to)));
}

describe('approval matrix', () => {
  test('six contracts, eleven grants', () => {
    expect(APPROVAL_TARGETS).toHaveLength(6);
    const grants = APPROVAL_TARGETS.reduce(
      (n, t) => n + (t.collateral ? 1 : 0) + (t.ctfOperator ? 1 : 0),
      0,
    );
    expect(grants).toBe(11);
  });

  test('every target needs a pUSD allowance; only Conditional Tokens skips operator rights', () => {
    for (const t of APPROVAL_TARGETS) expect(t.collateral).toBe(true);
    const noOperator = APPROVAL_TARGETS.filter((t) => !t.ctfOperator).map((t) => t.name);
    expect(noOperator).toEqual(['Conditional Tokens']);
  });

  test('addresses are valid and distinct', () => {
    const seen = new Set<string>();
    for (const t of APPROVAL_TARGETS) {
      expect(() => getAddress(t.address)).not.toThrow();
      seen.add(t.address.toLowerCase());
    }
    expect(seen.size).toBe(APPROVAL_TARGETS.length);
  });
});

describe('checkApprovals', () => {
  test('reads eleven grants and reports each', async () => {
    stubCalls(() => TRUE_WORD);
    const rows = await checkApprovals(OWNER);
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.approved)).toBe(true);
  });

  test('a zero allowance is not approved', async () => {
    stubCalls((to) => (to.toLowerCase() === PUSD_ADDRESS.toLowerCase() ? FALSE_WORD : TRUE_WORD));
    const rows = await checkApprovals(OWNER);
    const collateral = rows.filter((r) => r.kind === 'collateral');
    expect(collateral.every((r) => !r.approved)).toBe(true);
    expect(rows.filter((r) => r.kind === 'ctf').every((r) => r.approved)).toBe(true);
  });

  test('a max allowance reads back as a number rather than overflowing', async () => {
    stubCalls(() => MAX_WORD);
    const rows = await checkApprovals(OWNER);
    const one = rows.find((r) => r.kind === 'collateral')!;
    expect(one.approved).toBe(true);
    expect(Number.isFinite(one.allowance!)).toBe(true);
  });

  test('a failed read is an error, NOT an unapproved grant', async () => {
    // This distinction is the whole point: treating an unreachable RPC as
    // "unapproved" would make `wallet approve` pay gas to re-grant permissions
    // that are already in place.
    spies.push(
      spyOn(rpc, 'ethCall').mockImplementation(async () => {
        throw new Error('RPC gated');
      }),
    );
    const rows = await checkApprovals(OWNER);
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.error)).toBe(true);
    expect(pendingApprovals(rows)).toHaveLength(0);
  });
});

describe('pendingApprovals', () => {
  const row = (over: Partial<ApprovalStatus>): ApprovalStatus => ({
    target: 'X',
    kind: 'collateral',
    spender: APPROVAL_TARGETS[0]!.address,
    approved: false,
    allowance: 0,
    ...over,
  });

  test('keeps only grants known to be missing', () => {
    const rows = [
      row({ approved: true }),
      row({ approved: false }),
      row({ approved: false, error: 'unreadable' }),
    ];
    expect(pendingApprovals(rows)).toHaveLength(1);
  });
});

describe('buildApprovalBatch', () => {
  const proxyAbi = parseAbi([
    'struct ProxyCall { uint8 typeCode; address to; uint256 value; bytes data; }',
    'function proxy(ProxyCall[] calls) payable returns (bytes[])',
  ]);
  const ctfAbi = parseAbi(['function setApprovalForAll(address operator, bool approved)']);

  function decodeBatch(data: `0x${string}`) {
    const { args } = decodeFunctionData({ abi: proxyAbi, data });
    return args![0] as ReadonlyArray<{ typeCode: number; to: string; value: bigint; data: `0x${string}` }>;
  }

  test('one sub-call per pending grant, all plain CALLs with no value attached', async () => {
    stubCalls(() => FALSE_WORD);
    const pending = pendingApprovals(await checkApprovals(OWNER));
    const calls = decodeBatch(buildApprovalBatch(pending));

    expect(calls).toHaveLength(pending.length);
    for (const c of calls) {
      expect(c.typeCode).toBe(1);
      expect(c.value).toBe(0n);
    }
  });

  test('pUSD grants approve the spender for the maximum, on the pUSD contract', async () => {
    stubCalls(() => FALSE_WORD);
    const pending = pendingApprovals(await checkApprovals(OWNER));
    const calls = decodeBatch(buildApprovalBatch(pending));

    const collateralCalls = calls.filter((c) => c.to.toLowerCase() === PUSD_ADDRESS.toLowerCase());
    expect(collateralCalls).toHaveLength(6);
    for (const c of collateralCalls) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
      expect(functionName).toBe('approve');
      expect(args![1]).toBe(maxUint256);
    }
  });

  test('CTF grants set operator rights on the Conditional Tokens contract', async () => {
    stubCalls(() => FALSE_WORD);
    const pending = pendingApprovals(await checkApprovals(OWNER));
    const calls = decodeBatch(buildApprovalBatch(pending));

    const ctfCalls = calls.filter((c) => c.to.toLowerCase() === CONDITIONAL_TOKENS.toLowerCase());
    expect(ctfCalls).toHaveLength(5);
    for (const c of ctfCalls) {
      const { functionName, args } = decodeFunctionData({ abi: ctfAbi, data: c.data });
      expect(functionName).toBe('setApprovalForAll');
      expect(args![1]).toBe(true);
    }
  });

  test('already-approved grants are not re-sent', async () => {
    // Only the ERC-1155 side is missing.
    stubCalls((to) => (to.toLowerCase() === PUSD_ADDRESS.toLowerCase() ? MAX_WORD : FALSE_WORD));
    const pending = pendingApprovals(await checkApprovals(OWNER));
    const calls = decodeBatch(buildApprovalBatch(pending));

    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.to.toLowerCase() === CONDITIONAL_TOKENS.toLowerCase())).toBe(true);
  });
});
