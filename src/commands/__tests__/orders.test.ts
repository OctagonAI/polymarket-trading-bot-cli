import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { handleOrders, handleCancelOrders, formatOrdersHuman, formatCancelHuman } from '../orders.js';
import { parseArgs } from '../parse-args.js';
import * as clob from '../../clob/client.js';
import * as markets from '../../tools/polymarket/markets.js';
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
  spies.push(
    spyOn(clob, 'getClobClient').mockImplementation(
      async () => ({ account: { wallet: WALLET }, ...impl }) as never,
    ),
  );
}

/** `listOpenOrders` is paginated; the command reads the first page. */
function pageOf(items: unknown[]) {
  return () => ({ firstPage: async () => ({ items, hasMore: false }) });
}

function stubAuthFailure(message: string) {
  spies.push(
    spyOn(clob, 'getClobClient').mockImplementation(async () => {
      throw new ClobAuthError(message);
    }),
  );
}

const WALLET = '0x18eD5C15CeD1bFdf88e701601C4a0BbD4F5142dE';
const ID_A = `0x${'a'.repeat(64)}`;
const ID_B = `0x${'b'.repeat(64)}`;

const openOrder = (over: Record<string, unknown> = {}) => ({
  id: '0xorder1',
  status: 'LIVE',
  owner: 'o',
  makerAddress: 'm',
  conditionId: 'will-btc-hit-100k',
  assetId: '123',
  tokenId: '123',
  side: 'BUY',
  originalSize: '100',
  sizeMatched: '0',
  price: '0.42',
  associateTrades: [],
  outcome: 'Yes',
  createdAt: '2025-06-15T12:26:40.000Z',
  orderType: 'GTC',
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
      listOpenOrders: pageOf([openOrder({ originalSize: '100', sizeMatched: '30' })]),
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
      listOpenOrders: pageOf([openOrder({ originalSize: '100', sizeMatched: '120' })]),
    });
    const resp = await handleOrders(parseArgs(['orders']));
    expect(resp.data.orders[0]!.remaining).toBe(0);
  });

  test('an empty book is a normal result, not an error', async () => {
    stubClient({ listOpenOrders: pageOf([]) });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(true);
    expect(resp.data.orders).toHaveLength(0);
    expect(formatOrdersHuman(resp.data)).toContain('No resting orders');
  });

  test('a CLOB failure is distinguishable from an auth failure', async () => {
    stubClient({
      listOpenOrders: () => ({
        firstPage: async () => {
          throw new Error('503 Service Unavailable');
        },
      }),
    });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('CLOB_ERROR');
  });

  test('the table names the id needed to cancel', async () => {
    stubClient({ listOpenOrders: pageOf([openOrder()]) });
    const resp = await handleOrders(parseArgs(['orders']));
    const text = formatOrdersHuman(resp.data);

    expect(text).toContain('0xorder1');
    expect(text).toContain('$0.42');
    expect(text).toContain('polymarket orders cancel');
  });
});

describe('orders — naming and detail', () => {
  function stubMarkets(found: Array<{ condition_id: string; ticker: string; title: string }>) {
    spies.push(
      spyOn(markets, 'fetchMarkets').mockImplementation(async () => found as never),
    );
  }

  test('a condition id is replaced by the market it belongs to', async () => {
    // 66 characters of hex tells the reader nothing about what they bought.
    stubMarkets([{ condition_id: '0xcond', ticker: 'btc-200k', title: 'Will BTC hit 200k?' }]);
    stubClient({ listOpenOrders: pageOf([openOrder({ conditionId: '0xcond' })]) });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.data.orders[0]!.market).toBe('btc-200k');
    expect(resp.data.orders[0]!.title).toBe('Will BTC hit 200k?');
    expect(formatOrdersHuman(resp.data)).toContain('Will BTC hit 200k?');
  });

  test('an unresolvable market still shows its condition id', async () => {
    // Naming is a convenience. Losing it must not lose the order.
    spies.push(
      spyOn(markets, 'fetchMarkets').mockImplementation(async () => {
        throw new Error('gamma down');
      }),
    );
    stubClient({ listOpenOrders: pageOf([openOrder({ conditionId: '0xcond' })]) });
    const resp = await handleOrders(parseArgs(['orders']));

    expect(resp.ok).toBe(true);
    expect(resp.data.orders[0]!.market).toBe('0xcond');
  });

  test('every market is named in one request, not one each', async () => {
    const spy = spyOn(markets, 'fetchMarkets').mockImplementation(async () => [] as never);
    spies.push(spy);
    stubClient({
      listOpenOrders: pageOf([
        openOrder({ id: ID_A, conditionId: '0xc1' }),
        openOrder({ id: ID_B, conditionId: '0xc2' }),
        openOrder({ id: `0x${'c'.repeat(64)}`, conditionId: '0xc1' }),
      ]),
    });
    await handleOrders(parseArgs(['orders']));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ condition_ids: ['0xc1', '0xc2'] });
  });

  test('a delayed order is called out, since there is no status column', async () => {
    // The table drops Status because this endpoint only returns open orders, so
    // LIVE is a constant. DELAYED is not — it means the order is queued behind
    // a market's matching delay rather than working — so it must survive.
    stubMarkets([]);
    stubClient({ listOpenOrders: pageOf([openOrder({ id: ID_A, status: 'DELAYED' })]) });
    const resp = await handleOrders(parseArgs(['orders']));

    const text = formatOrdersHuman(resp.data);
    expect(text).toContain('100.00*');
    expect(text).toContain('* DELAYED');
    // The star never lands on the id, which is meant to be copied into cancel.
    expect(text).not.toContain(`${ID_A.slice(0, 12)}*`);
  });

  test('one note however many orders are delayed', () => {
    const delayed = (id: string) => ({
      id, conditionId: '0xc', market: '0xc', side: 'BUY', outcome: 'Yes',
      price: 0.1, size: 10, filled: 0, remaining: 10, status: 'DELAYED', createdAt: null,
    });
    const text = formatOrdersHuman({ orders: [delayed(ID_A), delayed(ID_B)], address: WALLET });
    expect(text.match(/\* DELAYED/g)).toHaveLength(1);
  });

  test('a live order says nothing about its status', async () => {
    stubMarkets([]);
    stubClient({ listOpenOrders: pageOf([openOrder({ id: ID_A, status: 'LIVE' })]) });
    const resp = await handleOrders(parseArgs(['orders']));
    expect(formatOrdersHuman(resp.data)).not.toContain('not working');
  });

  test('orders <prefix> shows one order, with the full id to cancel by', async () => {
    stubMarkets([]);
    stubClient({ listOpenOrders: pageOf([openOrder({ id: ID_A }), openOrder({ id: ID_B })]) });
    const resp = await handleOrders(parseArgs(['orders', ID_A.slice(0, 12)]));

    expect(resp.ok).toBe(true);
    expect(resp.data.orders).toHaveLength(1);
    expect(formatOrdersHuman(resp.data)).toContain(ID_A);
  });

  test('an ambiguous prefix names the candidates instead of picking one', async () => {
    stubMarkets([]);
    stubClient({
      listOpenOrders: pageOf([openOrder({ id: ID_A }), openOrder({ id: `0x${'a'.repeat(63)}b` })]),
    });
    const resp = await handleOrders(parseArgs(['orders', '0xaaaa']));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('AMBIGUOUS');
  });
});

/**
 * `cancel` is a verb on the orders resource, and the dispatcher consumes the
 * verb before the handler runs — so what reaches it is just the ids.
 */
const cancelArgs = (...rest: string[]) => parseArgs(['orders', ...rest]);

describe('orders cancel', () => {
  test('no id and no --all is a usage error, not a silent no-op', async () => {
    const resp = await handleCancelOrders(cancelArgs());
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('MISSING_ARG');
  });

  test('ids that could not be cancelled are reported, not counted as cancelled', async () => {
    // An order that filled a moment before the cancel landed is the common
    // case. Reporting it as cancelled would be a lie with money behind it.
    stubClient({
      cancelOrders: async () => ({
        canceled: [ID_A],
        notCanceled: { [ID_B]: 'order already filled' },
      }),
    });
    const resp = await handleCancelOrders(cancelArgs(ID_A, ID_B));

    expect(resp.ok).toBe(true);
    expect(resp.data.cancelled).toEqual([ID_A]);
    expect(resp.data.failed).toEqual([{ id: ID_B, reason: 'order already filled' }]);

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
    const resp = await handleCancelOrders(cancelArgs('--all'));

    expect(usedCancelAll).toBe(true);
    expect(resp.data.cancelled).toHaveLength(2);
  });

  test('a response with neither list is handled rather than crashing', async () => {
    stubClient({ cancelOrders: async () => ({}) });
    const resp = await handleCancelOrders(cancelArgs(ID_A));

    expect(resp.ok).toBe(true);
    expect(resp.data.cancelled).toEqual([]);
    expect(formatCancelHuman(resp.data)).toContain('Nothing was cancelled');
  });

  test('a short id from the table is resolved against the open book', async () => {
    // `orders` cannot print a 66-character id in a table, so it prints a
    // prefix. Cancel has to accept what was displayed or the hint is a lie.
    let sent: string[] = [];
    stubClient({
      listOpenOrders: pageOf([openOrder({ id: ID_A })]),
      cancelOrders: async (req: { orderIds: string[] }) => {
        sent = req.orderIds;
        return { canceled: req.orderIds, notCanceled: {} };
      },
    });
    const resp = await handleCancelOrders(cancelArgs(ID_A.slice(0, 12)));

    expect(resp.ok).toBe(true);
    expect(sent).toEqual([ID_A]);
  });

  test('an ambiguous prefix cancels nothing', async () => {
    // Cancelling the wrong order is cheap but not free: it is the one the user
    // wanted to keep.
    let called = false;
    stubClient({
      listOpenOrders: pageOf([openOrder({ id: ID_A }), openOrder({ id: `0x${'a'.repeat(63)}b` })]),
      cancelOrders: async () => {
        called = true;
        return { canceled: [], notCanceled: {} };
      },
    });
    const resp = await handleCancelOrders(cancelArgs('0xaaaa'));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('AMBIGUOUS');
    expect(called).toBe(false);
  });

  test('a prefix that matches nothing is refused, not passed through', async () => {
    stubClient({
      listOpenOrders: pageOf([openOrder({ id: ID_A })]),
      cancelOrders: async () => ({ canceled: [], notCanceled: {} }),
    });
    const resp = await handleCancelOrders(cancelArgs('0xdead'));

    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('NOT_FOUND');
  });

  test('no key means no cancel, with the reason', async () => {
    stubAuthFailure('No wallet configured.');
    const resp = await handleCancelOrders(cancelArgs(ID_A));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('AUTH');
  });
});
