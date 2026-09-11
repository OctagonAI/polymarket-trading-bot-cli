import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { handleOrders, handleCancelOrders, formatOrdersHuman, formatCancelHuman } from '../orders.js';
import { parseArgs } from '../parse-args.js';
import * as clob from '../../clob/client.js';
import { ClobAuthError } from '../../clob/client.js';

/**
 * `orders` and `cancel` ship before placement on purpose, so these cover the
 * two things that matter before anything can rest on the book: that they refuse
 * clearly without a key, and that cancel reports what actually happened rather
 * than assuming success.
 */

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function stubClient(impl: Record<string, unknown>) {
  spies.push(spyOn(clob, 'getClobClient').mockImplementation(async () => impl as never));
}

function stubAuthFailure(message: string) {
  spies.push(
    spyOn(clob, 'getClobClient').mockImplementation(async () => {
      throw new ClobAuthError(message);
    }),
  );
}

const openOrder = (over: Record<string, unknown> = {}) => ({
  id: '0xorder1',
  status: 'LIVE',
  owner: 'o',
  maker_address: 'm',
  market: 'will-btc-hit-100k',
  asset_id: '123',
  side: 'BUY',
  original_size: '100',
  size_matched: '0',
  price: '0.42',
  associate_trades: [],
  outcome: 'Yes',
  created_at: 1_750_000_000,
  expiration: '0',
  ...over,
});

describe('orders', () => {
  test('a watch-only wallet is refused with the command that fixes it', async () => {
    stubAuthFailure('This wallet is watch-only. Run `polymarket wallet import <private-key> --force`');
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('AUTH');
    expect(resp.error?.message).toContain('wallet import');
  });

  test('remaining size is size minus fills, which is what decides a cancel', async () => {
    stubClient({
      getOpenOrders: async () => [openOrder({ original_size: '100', size_matched: '30' })],
    });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(true);
    const o = resp.data.orders[0]!;
    expect(o.size).toBe(100);
    expect(o.filled).toBe(30);
    expect(o.remaining).toBe(70);
  });

  test('an over-filled order never reports negative remaining', async () => {
    stubClient({
      getOpenOrders: async () => [openOrder({ original_size: '100', size_matched: '120' })],
    });
    const resp = await handleOrders(parseArgs(['orders']));
    expect(resp.data.orders[0]!.remaining).toBe(0);
  });

  test('an empty book is a normal result, not an error', async () => {
    stubClient({ getOpenOrders: async () => [] });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(true);
    expect(resp.data.orders).toHaveLength(0);
    expect(formatOrdersHuman(resp.data)).toContain('No resting orders');
  });

  test('a CLOB failure is distinguishable from an auth failure', async () => {
    stubClient({
      getOpenOrders: async () => {
        throw new Error('503 Service Unavailable');
      },
    });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('CLOB_ERROR');
  });

  test('the table names the id needed to cancel', async () => {
    stubClient({ getOpenOrders: async () => [openOrder()] });
    const resp = await handleOrders(parseArgs(['orders']));
    const text = formatOrdersHuman(resp.data);

    expect(text).toContain('0xorder1');
    expect(text).toContain('$0.42');
    expect(text).toContain('polymarket cancel');
  });
});

describe('cancel', () => {
  test('no id and no --all is a usage error, not a silent no-op', async () => {
    const resp = await handleCancelOrders(parseArgs(['cancel']));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('MISSING_ARG');
  });

  test('ids that could not be cancelled are reported, not counted as cancelled', async () => {
    // An order that filled a moment before the cancel landed is the common
    // case. Reporting it as cancelled would be a lie with money behind it.
    stubClient({
      cancelOrders: async () => ({
        canceled: ['0xa'],
        not_canceled: { '0xb': 'order already filled' },
      }),
    });
    const resp = await handleCancelOrders(parseArgs(['cancel', '0xa', '0xb']));

    expect(resp.ok).toBe(true);
    expect(resp.data.cancelled).toEqual(['0xa']);
    expect(resp.data.failed).toEqual([{ id: '0xb', reason: 'order already filled' }]);

    const text = formatCancelHuman(resp.data);
    expect(text).toContain('Cancelled 1');
    expect(text).toContain('order already filled');
  });

  test('--all routes to cancelAll rather than passing an empty id list', async () => {
    let usedCancelAll = false;
    stubClient({
      cancelAll: async () => {
        usedCancelAll = true;
        return { canceled: ['0xa', '0xb'] };
      },
      cancelOrders: async () => {
        throw new Error('cancelOrders must not be used for --all');
      },
    });
    const resp = await handleCancelOrders(parseArgs(['cancel', '--all']));

    expect(usedCancelAll).toBe(true);
    expect(resp.data.cancelled).toHaveLength(2);
  });

  test('a response with neither list is handled rather than crashing', async () => {
    stubClient({ cancelOrders: async () => ({}) });
    const resp = await handleCancelOrders(parseArgs(['cancel', '0xa']));

    expect(resp.ok).toBe(true);
    expect(resp.data.cancelled).toEqual([]);
    expect(formatCancelHuman(resp.data)).toContain('Nothing was cancelled');
  });

  test('no key means no cancel, with the reason', async () => {
    stubAuthFailure('No wallet configured.');
    const resp = await handleCancelOrders(parseArgs(['cancel', '0xa']));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('AUTH');
  });
});
