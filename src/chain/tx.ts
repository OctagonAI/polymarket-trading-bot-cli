/**
 * Signing and sending a Polygon transaction.
 *
 * The key never leaves this process and never touches the network: viem signs
 * offline and the resulting raw transaction goes out through the same
 * `rpcCall` every read uses, so all network I/O stays under `fetchWithDeadline`
 * rather than inside a library's own transport.
 *
 * This is the only module in the CLI that can spend money. Everything it
 * exports either estimates (free, read-only) or requires a private key passed
 * in explicitly — there is no ambient "current wallet" here, so a caller cannot
 * send a transaction without having deliberately fetched the key.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, formatEther } from 'viem';
import { rpcCall, ethGetBalance, POLYGON_CHAIN_ID } from './rpc.js';

/**
 * Polygon validators drop transactions below roughly 25 gwei priority fee, and
 * a dropped transaction is worse than an expensive one: it sits pending with no
 * error until the user gives up.
 */
const MIN_PRIORITY_FEE_WEI = 30_000_000_000n; // 30 gwei

/** Estimates come back tight; a revert from running out of gas costs the fee anyway. */
const GAS_BUFFER_PERCENT = 25n;

const RECEIPT_POLL_MS = 2_000;
const RECEIPT_TIMEOUT_MS = 180_000;

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  /** Worst-case cost in POL: gasLimit × maxFeePerGas. */
  maxCostWei: bigint;
}

function toBigInt(value: unknown, fallback = 0n): bigint {
  return typeof value === 'string' && value.startsWith('0x') ? BigInt(value) : fallback;
}

async function currentBaseFee(): Promise<bigint> {
  const block = (await rpcCall('eth_getBlockByNumber', ['latest', false])) as
    | { baseFeePerGas?: string }
    | null;
  return toBigInt(block?.baseFeePerGas);
}

async function priorityFee(): Promise<bigint> {
  try {
    const raw = await rpcCall('eth_maxPriorityFeePerGas', []);
    const suggested = toBigInt(raw);
    return suggested > MIN_PRIORITY_FEE_WEI ? suggested : MIN_PRIORITY_FEE_WEI;
  } catch {
    // Not every endpoint implements it. The floor is the safe answer.
    return MIN_PRIORITY_FEE_WEI;
  }
}

export async function estimateGas(from: string, to: string, data: string): Promise<bigint> {
  const raw = await rpcCall('eth_estimateGas', [
    { from: getAddress(from), to: getAddress(to), data },
  ]);
  const estimate = toBigInt(raw);
  return estimate + (estimate * GAS_BUFFER_PERCENT) / 100n;
}

/**
 * Everything needed to quote the cost before asking for confirmation.
 *
 * `eth_estimateGas` also acts as a dry run: it executes the call against
 * current state, so a transaction that would revert fails here — before the
 * user is asked to approve anything and before any gas is spent.
 */
export async function estimateFees(from: string, to: string, data: string): Promise<FeeEstimate> {
  const [base, priority, gasLimit] = await Promise.all([
    currentBaseFee(),
    priorityFee(),
    estimateGas(from, to, data),
  ]);
  // Double the base fee so the transaction survives a few blocks of congestion;
  // the unused portion is refunded, unlike with legacy gas pricing.
  const maxFeePerGas = base * 2n + priority;
  return { maxFeePerGas, maxPriorityFeePerGas: priority, gasLimit, maxCostWei: gasLimit * maxFeePerGas };
}

export function formatPol(wei: bigint, decimals = 4): string {
  return Number(formatEther(wei)).toFixed(decimals);
}

/** Native POL balance of the signing EOA — this is who pays the gas. */
export async function polBalance(address: string): Promise<bigint> {
  return ethGetBalance(address);
}

export interface SentTransaction {
  hash: string;
  from: string;
}

/** Sign offline and broadcast. Returns as soon as the node accepts it. */
export async function signAndSend(
  privateKey: `0x${string}`,
  to: string,
  data: string,
  fees: FeeEstimate,
): Promise<SentTransaction> {
  const account = privateKeyToAccount(privateKey);
  const nonceRaw = await rpcCall('eth_getTransactionCount', [account.address, 'pending']);

  const signed = await account.signTransaction({
    chainId: POLYGON_CHAIN_ID,
    to: getAddress(to),
    data: data as `0x${string}`,
    value: 0n,
    nonce: Number(toBigInt(nonceRaw)),
    gas: fees.gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    type: 'eip1559',
  });

  const hash = (await rpcCall('eth_sendRawTransaction', [signed])) as string;
  return { hash, from: account.address };
}

export interface Receipt {
  /** True when the transaction executed successfully on-chain. */
  success: boolean;
  blockNumber: number | null;
  gasUsed: bigint;
}

/**
 * Poll until the transaction is mined.
 *
 * A receipt with `status: 0x0` means it was mined and REVERTED — the gas is
 * spent and nothing was approved. That is reported as a failure rather than as
 * a successful send, because "we have a transaction hash" is not the same as
 * "it worked".
 */
export async function waitForReceipt(hash: string): Promise<Receipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const receipt = (await rpcCall('eth_getTransactionReceipt', [hash])) as
      | { status?: string; blockNumber?: string; gasUsed?: string }
      | null;

    if (receipt) {
      return {
        success: toBigInt(receipt.status) === 1n,
        blockNumber: receipt.blockNumber ? Number(toBigInt(receipt.blockNumber)) : null,
        gasUsed: toBigInt(receipt.gasUsed),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }

  throw new Error(
    `Transaction ${hash} was not mined within ${RECEIPT_TIMEOUT_MS / 1000}s. ` +
      'It may still confirm — check polygonscan before resending, or the approval could be sent twice.',
  );
}
