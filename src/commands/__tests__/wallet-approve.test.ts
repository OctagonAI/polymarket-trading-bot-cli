import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { handleWallet } from '../wallet.js';
import { parseArgs } from '../parse-args.js';
import * as identity from '../../wallet/identity.js';
import * as approvals from '../../chain/approvals.js';
import * as tx from '../../chain/tx.js';
import type { ApprovalStatus } from '../../chain/approvals.js';

/**
 * `wallet approve` spends real money. These tests pin the one property that
 * matters most: it does not send unless the user said so, and it refuses rather
 * than guessing whenever it is unsure what needs granting.
 */

const PROXY = '0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563';
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
    approved: false,
    allowance: 0,
    ...over,
  };
}

function setup(opts: {
  tier?: identity.WalletTier;
  statuses?: ApprovalStatus[];
  pol?: bigint;
  maxCost?: bigint;
}) {
  const tier = opts.tier ?? 'trade';
  spies.push(
    spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
      tier,
      address: PROXY,
      ...(tier === 'trade' ? { signer: SIGNER } : {}),
      source: 'file' as const,
    })),
    spyOn(approvals, 'checkApprovals').mockImplementation(async () => opts.statuses ?? [status()]),
    spyOn(tx, 'polBalance').mockImplementation(async () => opts.pol ?? 10n ** 18n),
    spyOn(tx, 'estimateFees').mockImplementation(async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasLimit: 1n,
      maxCostWei: opts.maxCost ?? 10n ** 15n,
    })),
  );
  const sendSpy = spyOn(tx, 'signAndSend').mockImplementation(async () => {
    throw new Error('signAndSend must not be reached in this test');
  });
  spies.push(sendSpy);
  return sendSpy;
}

const run = (argv: string[]) => handleWallet(parseArgs(['wallet', ...argv]));

describe('wallet approve — consent', () => {
  test('a watch-only wallet is refused before anything is read or estimated', async () => {
    const send = setup({ tier: 'watch' });
    const resp = await run(['approve']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('WATCH_ONLY');
    expect(send).not.toHaveBeenCalled();
  });

  test('no wallet at all is refused', async () => {
    spies.push(
      spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
        tier: 'none' as const,
        source: 'none' as const,
      })),
    );
    const resp = await run(['approve']);
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('NO_WALLET');
  });

  test('nothing is sent in a non-TTY without --yes', async () => {
    // Piped or scripted invocations must not be able to spend by accident. The
    // prompt cannot be answered, so the answer is no.
    const send = setup({ statuses: [status({ approved: false })] });
    const wasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const resp = await run(['approve']);
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('CANCELLED');
      expect(send).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });
});

describe('wallet approve — refuses to guess', () => {
  test('an unreadable approval blocks the send rather than re-granting blind', async () => {
    // Re-sending a grant that is already in place burns gas for nothing, so an
    // RPC failure must stop the run instead of being read as "not approved".
    const send = setup({
      statuses: [status({ approved: true }), status({ approved: false, error: 'RPC gated' })],
    });
    const resp = await run(['approve', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('CHECK_FAILED');
    expect(send).not.toHaveBeenCalled();
  });

  test('everything already approved sends nothing and says so', async () => {
    const send = setup({ statuses: [status({ approved: true }), status({ approved: true })] });
    const resp = await run(['approve', '--yes']);

    expect(resp.ok).toBe(true);
    expect(resp.data.sent).toBe(false);
    expect(resp.data.pendingCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  test('too little POL is refused before signing, naming the signing wallet', async () => {
    const send = setup({ pol: 0n, maxCost: 10n ** 17n });
    const resp = await run(['approve', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INSUFFICIENT_GAS');
    // The commonest mistake is funding the wrong address, so the message must
    // distinguish them.
    expect(resp.error?.message).toContain(SIGNER);
    expect(resp.error?.message).toContain('not the funding wallet');
    expect(send).not.toHaveBeenCalled();
  });

  test('a failed estimate is reported instead of sending an unpriced transaction', async () => {
    const send = setup({});
    for (const s of spies.splice(0)) s.mockRestore();
    setup({});
    spies.push(
      spyOn(tx, 'estimateFees').mockImplementation(async () => {
        throw new Error('execution reverted');
      }),
    );
    const resp = await run(['approve', '--yes']);

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('ESTIMATE_FAILED');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('wallet approve — the send path', () => {
  test('--yes sends the batch, waits for the receipt, and re-reads the state', async () => {
    setup({ statuses: [status({ approved: false })] });
    for (const sp of spies.splice(0)) sp.mockRestore();

    let checkCalls = 0;
    spies.push(
      spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
        tier: 'trade' as const, address: PROXY, signer: SIGNER, source: 'file' as const,
      })),
      spyOn(identity, 'loadPrivateKey').mockImplementation(() => `0x${'11'.repeat(32)}` as `0x${string}`),
      spyOn(approvals, 'checkApprovals').mockImplementation(async () => {
        checkCalls += 1;
        // Second read happens after the send, so it reflects the new state.
        return [status({ approved: checkCalls > 1 })];
      }),
      spyOn(tx, 'polBalance').mockImplementation(async () => 10n ** 18n),
      spyOn(tx, 'estimateFees').mockImplementation(async () => ({
        maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n, maxCostWei: 10n ** 15n,
      })),
      spyOn(tx, 'signAndSend').mockImplementation(async () => ({ hash: '0xdead', from: SIGNER })),
      spyOn(tx, 'waitForReceipt').mockImplementation(async () => ({
        success: true, blockNumber: 1, gasUsed: 21_000n,
      })),
    );

    const resp = await run(['approve', '--yes']);
    expect(resp.ok).toBe(true);
    expect(resp.data.sent).toBe(true);
    expect(resp.data.txHash).toBe('0xdead');
    // Re-read rather than assumed: the check is what is authoritative.
    expect(checkCalls).toBe(2);
    expect(resp.data.pendingCount).toBe(0);
  });

  test('a reverted transaction is an error, not a successful send', async () => {
    spies.push(
      spyOn(identity, 'loadWalletIdentity').mockImplementation(() => ({
        tier: 'trade' as const, address: PROXY, signer: SIGNER, source: 'file' as const,
      })),
      spyOn(identity, 'loadPrivateKey').mockImplementation(() => `0x${'11'.repeat(32)}` as `0x${string}`),
      spyOn(approvals, 'checkApprovals').mockImplementation(async () => [status({ approved: false })]),
      spyOn(tx, 'polBalance').mockImplementation(async () => 10n ** 18n),
      spyOn(tx, 'estimateFees').mockImplementation(async () => ({
        maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 1n, maxCostWei: 10n ** 15n,
      })),
      spyOn(tx, 'signAndSend').mockImplementation(async () => ({ hash: '0xbad', from: SIGNER })),
      spyOn(tx, 'waitForReceipt').mockImplementation(async () => ({
        success: false, blockNumber: 1, gasUsed: 21_000n,
      })),
    );

    const resp = await run(['approve', '--yes']);
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('TX_REVERTED');
    expect(resp.error?.message).toContain('Gas was spent');
  });
});

describe('wallet approve --check', () => {
  test('reports state and never sends, even for a watch-only wallet', async () => {
    const send = setup({
      tier: 'watch',
      statuses: [status({ approved: true }), status({ approved: false })],
    });
    const resp = await run(['approve', '--check']);

    expect(resp.ok).toBe(true);
    expect(resp.data.sent).toBe(false);
    expect(resp.data.pendingCount).toBe(1);
    expect(resp.data.approvals).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });
});
