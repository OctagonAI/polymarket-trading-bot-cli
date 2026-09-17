import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { handleWallet, formatWalletHuman } from '../wallet.js';
import { parseArgs } from '../parse-args.js';
import * as identity from '../../wallet/identity.js';
import * as approvals from '../../chain/approvals.js';
import type { ApprovalStatus } from '../../chain/approvals.js';

/**
 * `wallet approvals` reports and never sends. Polymarket grants these during
 * onboarding, so the job here is to say plainly what is in place and to keep an
 * unreadable grant distinct from a missing one — treating "could not read" as
 * "not approved" would send a user to fix something that is already fine.
 */

const WALLET = '0x18eD5C15CeD1bFdf88e701601C4a0BbD4F5142dE';
const SIGNER = '0xF2B909e5E2cBc2CFF2d07E02c9b1bAFd0B3A86a2';
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function status(over: Partial<ApprovalStatus> = {}): ApprovalStatus {
  return {
    target: 'CTF Exchange',
    kind: 'collateral',
    spender: '0xE111180000d2663C0091e4f400237545B87B996B',
    approved: true,
    required: true,
    allowance: 1e9,
    ...over,
  };
}

function setup(opts: { tier?: identity.WalletTier; statuses?: ApprovalStatus[] } = {}) {
  const tier = opts.tier ?? 'trade';
  spies.push(
    spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
      tier,
      address: WALLET,
      ...(tier === 'trade' ? { signer: SIGNER } : {}),
      source: 'file' as const,
    })),
    spyOn(approvals, 'checkApprovals').mockImplementation(async () => opts.statuses ?? [status()]),
  );
}

const run = (argv: string[]) => handleWallet(parseArgs(['wallet', ...argv]));

describe('wallet approvals', () => {
  test('a fully approved wallet reports ready', async () => {
    setup({ statuses: [status(), status({ kind: 'ctf' })] });
    const resp = await run(['approvals']);

    expect(resp.ok).toBe(true);
    expect(resp.data.readyToTrade).toBe(true);
    expect(resp.data.pendingCount).toBe(0);
  });

  test('optional grants are counted apart from required ones', async () => {
    // Reporting the four collateral-adapter grants alongside the required seven
    // made a wallet that trades perfectly well look broken.
    setup({
      statuses: [status(), status({ target: 'CTF Collateral Adapter', required: false, approved: false })],
    });
    const resp = await run(['approvals']);

    expect(resp.data.readyToTrade).toBe(true);
    expect(resp.data.pendingCount).toBe(0);
    expect(resp.data.optionalPendingCount).toBe(1);
  });

  test('a missing required grant names where to fix it', async () => {
    setup({ statuses: [status({ approved: false })] });
    const resp = await run(['approvals']);

    expect(resp.data.readyToTrade).toBe(false);
    expect(resp.data.pendingCount).toBe(1);
    expect(formatWalletHuman(resp.data)).toContain('polymarket.com');
  });

  test('an unreadable grant is not reported as unapproved', async () => {
    setup({ statuses: [status({ approved: false, error: 'rpc timeout' })] });
    const resp = await run(['approvals']);

    expect(resp.data.approvals?.[0]?.error).toBe('rpc timeout');
    expect(formatWalletHuman(resp.data)).toContain('could not read');
  });

  test('a watch-only wallet can still read its approvals', async () => {
    // Nothing is signed, so there is no reason to need a key for this.
    setup({ tier: 'watch' });
    const resp = await run(['approvals']);
    expect(resp.ok).toBe(true);
  });

  test('no wallet is a clear refusal rather than an empty table', async () => {
    spies.push(
      spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({ tier: 'none', source: 'none' })),
    );
    const resp = await run(['approvals']);
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('NO_WALLET');
  });

  test('`wallet approve` says where approvals actually happen', async () => {
    setup();
    const resp = await run(['approve']);
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('polymarket.com');
    expect(resp.error?.message).toContain('wallet approvals');
  });
});
