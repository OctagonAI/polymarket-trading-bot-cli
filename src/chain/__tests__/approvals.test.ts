import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { getAddress } from 'viem';
import * as rpc from '../rpc.js';
import {
  APPROVAL_TARGETS,
  checkApprovals,
  pendingApprovals,
  readyToTrade,
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

  test('only the two collateral adapters are optional', () => {
    // Every one of twelve sampled leaderboard accounts holds the seven
    // exchange-side grants; only four hold the adapter grants — and the
    // adapters' bytecode exposes only splitPosition/mergePositions/
    // redeemPositions, which order matching never touches.
    const optional = APPROVAL_TARGETS.filter((t) => !t.required).map((t) => t.name);
    expect(optional).toEqual(['CTF Collateral Adapter', 'Neg Risk CTF Collateral Adapter']);

    const requiredGrants = APPROVAL_TARGETS
      .filter((t) => t.required)
      .reduce((n, t) => n + (t.collateral ? 1 : 0) + (t.ctfOperator ? 1 : 0), 0);
    expect(requiredGrants).toBe(7);
  });

  test('every optional target explains why it is optional', () => {
    for (const t of APPROVAL_TARGETS.filter((x) => !x.required)) {
      expect(t.note).toBeTruthy();
    }
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
    // "unapproved" would send the user to re-grant permissions
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
    required: true,
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

  test('optional grants are excluded unless asked for', () => {
    // The default must not propose spending gas on a capability trading does
    // not need — which is what made a working wallet report four outstanding.
    const rows = [row({ required: true }), row({ required: false })];
    expect(pendingApprovals(rows)).toHaveLength(1);
    expect(pendingApprovals(rows, true)).toHaveLength(2);
  });

  test('readyToTrade ignores optional grants', () => {
    expect(readyToTrade([row({ required: true, approved: true }), row({ required: false })])).toBe(true);
    expect(readyToTrade([row({ required: true, approved: false })])).toBe(false);
  });
});
