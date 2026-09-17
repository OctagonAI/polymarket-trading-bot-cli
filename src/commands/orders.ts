/**
 * `orders` and `cancel` — the read and undo halves of order management.
 *
 * Deliberately shipped before order placement. An escape hatch that arrives
 * after the thing it rescues you from is not much of an escape hatch, and
 * neither of these can create exposure: listing is a read, and cancelling only
 * ever removes an order from the book.
 */
import type { ParsedArgs } from './parse-args.js';
import { wrapSuccess, wrapError, type CLIResponse } from './json.js';
import { getClobClient, ClobAuthError } from '../clob/client.js';
import { fetchMarkets } from '../tools/polymarket/markets.js';
import { formatTable } from './scan-formatters.js';
import { theme } from '../theme.js';

export interface OrderView {
  id: string;
  /** Market slug, resolved from the condition id. Falls back to the id itself. */
  market: string;
  /** Market question, when it could be resolved. */
  title?: string;
  conditionId: string;
  side: string;
  outcome: string;
  price: number;
  size: number;
  filled: number;
  remaining: number;
  status: string;
  createdAt: number | null;
}

export interface OrdersData {
  orders: OrderView[];
  address: string;
  /** Set when a single order was asked for by id or id prefix. */
  detail?: boolean;
  /** The venue had more orders than this page. See `handleOrders`. */
  truncated?: boolean;
}

/**
 * Name the markets the orders belong to.
 *
 * The CLOB identifies a market by condition id, which is 66 characters of hex
 * and tells a reader nothing. One batched Gamma lookup covers every order, and
 * failure is survivable: an unresolved order still shows its condition id,
 * which is worse to read but never wrong.
 */
async function nameMarkets(conditionIds: string[]): Promise<Map<string, { ticker: string; title: string }>> {
  const unique = [...new Set(conditionIds)].filter(Boolean);
  const named = new Map<string, { ticker: string; title: string }>();
  if (unique.length === 0) return named;

  try {
    const markets = await fetchMarkets({ condition_ids: unique, limit: unique.length });
    for (const m of markets) {
      if (m.condition_id) named.set(m.condition_id.toLowerCase(), { ticker: m.ticker, title: m.title });
    }
  } catch {
    // Names are a convenience; the orders themselves are the answer.
  }
  return named;
}

export interface CancelData {
  requested: string[];
  cancelled: string[];
  failed: Array<{ id: string; reason: string }>;
}

/** Exact id, else a unique prefix. Case-insensitive, `0x` optional. */
export function matchById<T extends { id: string }>(orders: T[], wanted: string): T[] {
  const needle = wanted.toLowerCase().replace(/^0x/, '');
  const exact = orders.filter((o) => o.id.toLowerCase().replace(/^0x/, '') === needle);
  if (exact.length > 0) return exact;
  return orders.filter((o) => o.id.toLowerCase().replace(/^0x/, '').startsWith(needle));
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function authError(err: unknown): CLIResponse<never> | null {
  if (err instanceof ClobAuthError) return wrapError('orders', 'AUTH', err.message);
  return null;
}

export async function handleOrders(args: ParsedArgs): Promise<CLIResponse<OrdersData>> {
  let client;
  try {
    client = await getClobClient();
  } catch (err) {
    return authError(err) ?? wrapError('orders', 'AUTH', err instanceof Error ? err.message : String(err));
  }

  try {
    // Resting orders are few enough that the first page is all of them; taking
    // one page keeps an unbounded wallet from paging forever.
    const page = await client.listOpenOrders().firstPage();
    // One page, deliberately: an unbounded wallet should not page forever. But
    // orders past it are dropped along with their ids, so the omission is
    // reported rather than left to look like an empty book.
    const truncated = page.hasMore === true;
    const named = await nameMarkets(page.items.map((o) => String(o.conditionId)));

    const all: OrderView[] = page.items.map((o) => {
      const size = num(o.originalSize);
      const filled = num(o.sizeMatched);
      const createdAt = Date.parse(o.createdAt ?? '');
      const conditionId = String(o.conditionId);
      const market = named.get(conditionId.toLowerCase());
      return {
        id: o.id,
        conditionId,
        market: market?.ticker ?? conditionId,
        ...(market?.title ? { title: market.title } : {}),
        side: String(o.side ?? '').toUpperCase(),
        outcome: o.outcome ?? '-',
        price: num(o.price),
        size,
        filled,
        // What is still working on the book, which is what you care about when
        // deciding whether to cancel.
        remaining: Math.max(0, size - filled),
        status: o.status ?? '-',
        createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : null,
      };
    });

    // `orders <id>` narrows to one. A prefix is enough — the table cannot show
    // a 66-character id, so requiring the whole thing would make the detail
    // view unreachable from the only place the id is displayed.
    const wanted = args.positionalArgs[0]?.trim();
    if (wanted) {
      const matches = matchById(all, wanted);
      if (matches.length === 0) {
        return wrapError('orders', 'NOT_FOUND', `No resting order matches "${wanted}".`);
      }
      if (matches.length > 1) {
        return wrapError(
          'orders',
          'AMBIGUOUS',
          `"${wanted}" matches ${matches.length} orders. Use more characters: ` +
            matches.map((m) => m.id.slice(0, 16)).join(', '),
        );
      }
      return wrapSuccess('orders', { orders: matches, address: client.account.wallet, detail: true });
    }

    return wrapSuccess('orders', {
      orders: all,
      address: client.account.wallet,
      ...(truncated ? { truncated: true } : {}),
    });
  } catch (err) {
    return wrapError('orders', 'CLOB_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Cancel by order id, or everything with `--all`.
 *
 * `--all` is not gated behind a confirmation: cancelling cannot lose money, and
 * the situation in which someone reaches for it — a bad run of orders resting
 * on a moving market — is exactly the one where a prompt is unwelcome.
 */
const FULL_ORDER_ID = /^0x[0-9a-fA-F]{64}$/;

export async function handleCancelOrders(args: ParsedArgs): Promise<CLIResponse<CancelData>> {
  const ids = args.positionalArgs.filter((a) => a.trim().length > 0);
  if (ids.length === 0 && !args.all) {
    return wrapError(
      'cancel',
      'MISSING_ARG',
      'Usage: orders cancel <order> [<order> …], or orders cancel --all for every resting order. ' +
        'A short id from `orders` is enough.',
    );
  }

  let client;
  try {
    client = await getClobClient();
  } catch (err) {
    return authError(err) ?? wrapError('cancel', 'AUTH', err instanceof Error ? err.message : String(err));
  }

  // `orders` shows a short id because a 66-character one does not fit a table,
  // so cancel has to accept what it displayed. A full id is passed straight
  // through; anything shorter is resolved against the open book first.
  let orderIds = ids;
  if (!args.all && ids.some((id) => !FULL_ORDER_ID.test(id))) {
    try {
      const open = (await client.listOpenOrders().firstPage()).items;
      const resolved: string[] = [];
      for (const id of ids) {
        if (FULL_ORDER_ID.test(id)) {
          resolved.push(id);
          continue;
        }
        const matches = matchById(open, id);
        if (matches.length === 0) {
          return wrapError('cancel', 'NOT_FOUND', `No resting order matches "${id}".`);
        }
        if (matches.length > 1) {
          return wrapError(
            'cancel',
            'AMBIGUOUS',
            `"${id}" matches ${matches.length} resting orders. Use more characters.`,
          );
        }
        resolved.push(matches[0]!.id);
      }
      orderIds = resolved;
    } catch (err) {
      return wrapError('cancel', 'CLOB_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const response = args.all ? await client.cancelAll() : await client.cancelOrders({ orderIds });
    // The CLOB reports per-order outcomes; an id that was already filled or
    // gone is reported rather than silently counted as cancelled.
    const cancelled: string[] = response?.canceled ?? [];
    const failed = Object.entries(response?.notCanceled ?? {}).map(([id, reason]) => ({
      id,
      reason: String(reason),
    }));
    return wrapSuccess('cancel', { requested: args.all ? cancelled : orderIds, cancelled, failed });
  } catch (err) {
    return wrapError('cancel', 'CLOB_ERROR', err instanceof Error ? err.message : String(err));
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Enough of an id to be unique in practice, and short enough to read. */
const SHORT_ID = 12;

function detailView(o: OrderView): string {
  const lines = [
    `  ${o.side} ${o.remaining.toFixed(2)} ${o.outcome} @ $${o.price.toFixed(2)}`,
    '',
  ];
  if (o.title) lines.push(`    ${o.title}`);
  lines.push(`    Market     ${o.market}`);
  lines.push(`    Status     ${o.status}`);
  lines.push(
    `    Size       ${o.size.toFixed(2)} placed, ${o.filled.toFixed(2)} filled, ${o.remaining.toFixed(2)} working`,
  );
  lines.push(`    Value      $${(o.remaining * o.price).toFixed(2)} at the limit price`);
  if (o.createdAt) lines.push(`    Placed     ${new Date(o.createdAt * 1000).toISOString()}`);
  lines.push(`    Condition  ${theme.muted(o.conditionId)}`);
  lines.push('');
  // The full id, on its own line, because this is the only place it fits and
  // `cancel` needs it.
  lines.push(`    ${o.id}`);
  lines.push('');
  lines.push(theme.muted(`    Cancel it with: polymarket orders cancel ${o.id.slice(0, SHORT_ID)}`));
  return lines.join('\n');
}

export function formatOrdersHuman(data: OrdersData): string {
  if (data.orders.length === 0) {
    return [
      '  No resting orders.',
      theme.muted('  Orders you place stay here until they fill, expire, or you cancel them.'),
    ].join('\n');
  }

  if (data.detail && data.orders[0]) return detailView(data.orders[0]);

  // An id and a condition id are both 66 characters, so a table that shows
  // everything shows nothing legibly: the id is truncated to a prefix and the
  // condition id gives way to the market's question.
  //
  // There is no status column. This endpoint returns open orders, so MATCHED,
  // UNMATCHED and CANCELED cannot appear and LIVE is a constant — a column that
  // spends ten characters to say what the row's existence already says. DELAYED
  // can appear and does mean something, so those rows are starred and explained
  // once underneath.
  const isLive = (o: OrderView) => o.status.toUpperCase() === 'LIVE';

  const rows = data.orders.map((o) => [
    o.id.slice(0, SHORT_ID),
    truncate(o.title ?? o.market, 44),
    o.side,
    truncate(o.outcome, 14),
    `$${o.price.toFixed(2)}`,
    // The star rides on the size rather than the id: the id is meant to be
    // copied into `orders cancel`, and a stray character there stops it matching.
    `${o.remaining.toFixed(2)}${isLive(o) ? '' : '*'}`,
  ]);

  const lines = [
    `  ${data.orders.length} resting order(s)`,
    '',
    formatTable(['Order', 'Market', 'Side', 'Outcome', 'Price', 'Remaining'], rows),
    '',
  ];

  if (data.truncated) {
    lines.push(theme.error(`  ! More orders are resting than the ${data.orders.length} shown.`));
    lines.push(theme.muted('    Cancel some, or use the Polymarket UI to see the rest.'));
    lines.push('');
  }

  const flagged = [...new Set(data.orders.filter((o) => !isLive(o)).map((o) => o.status.toUpperCase()))];
  for (const status of flagged) {
    lines.push(
      theme.muted(
        status === 'DELAYED'
          ? "  * DELAYED — queued behind the market's matching delay, not working on the book yet."
          : `  * ${status} — not working on the book.`,
      ),
    );
  }
  if (flagged.length > 0) lines.push('');

  lines.push(theme.muted('  Full detail:  polymarket orders <order>'));
  lines.push(theme.muted('  Cancel one:   polymarket orders cancel <order>'));
  lines.push(theme.muted('  The short id above is enough for both.'));
  return lines.join('\n');
}

export function formatCancelHuman(data: CancelData): string {
  const lines: string[] = [];
  if (data.cancelled.length > 0) {
    lines.push(theme.success(`  Cancelled ${data.cancelled.length} order(s).`));
    for (const id of data.cancelled) lines.push(theme.muted(`    ${id}`));
  } else {
    lines.push('  Nothing was cancelled.');
  }
  if (data.failed.length > 0) {
    lines.push('');
    lines.push(theme.error(`  ${data.failed.length} could not be cancelled:`));
    for (const f of data.failed) lines.push(`    ${f.id}  ${theme.muted(f.reason)}`);
  }
  return lines.join('\n');
}
