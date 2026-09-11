import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as rpc from '../rpc.js';
import { estimateGas, estimateFees, formatPol, waitForReceipt } from '../tx.js';

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const FROM = '0x2c335066fe58fe9237c3d3dc7b275c2a034a0563';
const TO = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

function stubRpc(handler: (method: string, params: unknown[]) => unknown) {
  spies.push(spyOn(rpc, 'rpcCall').mockImplementation(async (m, p) => handler(m, p)));
}

describe('gas estimation', () => {
  test('a buffer is added, because a revert for running out of gas still costs the fee', async () => {
    stubRpc((m) => (m === 'eth_estimateGas' ? hex(100_000) : null));
    expect(await estimateGas(FROM, TO, '0x')).toBe(125_000n);
  });

  test('the priority fee never falls below the Polygon floor', async () => {
    // Below ~25 gwei, validators drop the transaction — and a dropped
    // transaction sits pending with no error, which is worse than a dear one.
    stubRpc((m) => {
      if (m === 'eth_estimateGas') return hex(21_000);
      if (m === 'eth_maxPriorityFeePerGas') return hex(1_000_000_000); // 1 gwei
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: hex(50_000_000_000) };
      return null;
    });
    const fees = await estimateFees(FROM, TO, '0x');
    expect(fees.maxPriorityFeePerGas).toBe(30_000_000_000n);
  });

  test('a higher suggested priority fee is respected', async () => {
    stubRpc((m) => {
      if (m === 'eth_estimateGas') return hex(21_000);
      if (m === 'eth_maxPriorityFeePerGas') return hex(80_000_000_000);
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: hex(50_000_000_000) };
      return null;
    });
    expect((await estimateFees(FROM, TO, '0x')).maxPriorityFeePerGas).toBe(80_000_000_000n);
  });

  test('an endpoint without eth_maxPriorityFeePerGas still produces a quote', async () => {
    stubRpc((m) => {
      if (m === 'eth_estimateGas') return hex(21_000);
      if (m === 'eth_maxPriorityFeePerGas') throw new Error('method not found');
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: hex(50_000_000_000) };
      return null;
    });
    const fees = await estimateFees(FROM, TO, '0x');
    expect(fees.maxPriorityFeePerGas).toBe(30_000_000_000n);
    expect(fees.maxCostWei).toBe(fees.gasLimit * fees.maxFeePerGas);
  });

  test('max cost covers a doubling of the base fee', async () => {
    stubRpc((m) => {
      if (m === 'eth_estimateGas') return hex(100_000);
      if (m === 'eth_maxPriorityFeePerGas') return hex(30_000_000_000);
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: hex(100_000_000_000) };
      return null;
    });
    const fees = await estimateFees(FROM, TO, '0x');
    // base*2 + priority = 200 + 30 gwei
    expect(fees.maxFeePerGas).toBe(230_000_000_000n);
    expect(fees.gasLimit).toBe(125_000n);
  });
});

describe('formatPol', () => {
  test('renders wei as POL', () => {
    expect(formatPol(10n ** 18n)).toBe('1.0000');
    expect(formatPol(0n)).toBe('0.0000');
    expect(formatPol(334_200_000_000_000_000n)).toBe('0.3342');
  });
});

describe('waitForReceipt', () => {
  test('a mined-but-reverted transaction is a failure, not a success', async () => {
    // Having a transaction hash is not the same as the transaction working: on a
    // revert the gas is spent and nothing was approved.
    stubRpc((m) =>
      m === 'eth_getTransactionReceipt'
        ? { status: '0x0', blockNumber: hex(123), gasUsed: hex(21_000) }
        : null,
    );
    const receipt = await waitForReceipt('0xabc');
    expect(receipt.success).toBe(false);
    expect(receipt.blockNumber).toBe(123);
    expect(receipt.gasUsed).toBe(21_000n);
  });

  test('a successful receipt reports success', async () => {
    stubRpc((m) =>
      m === 'eth_getTransactionReceipt'
        ? { status: '0x1', blockNumber: hex(456), gasUsed: hex(50_000) }
        : null,
    );
    expect((await waitForReceipt('0xabc')).success).toBe(true);
  });
});
