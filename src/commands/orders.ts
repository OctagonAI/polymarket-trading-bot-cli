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
import { formatTable } from './scan-formatters.js';
import { theme } from '../theme.js';

export interface OrderView {
  id: string;
  /** Market slug when the CLOB supplies one, else the condition id. */
  market: string;
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
}

export interface CancelData {
  requested: string[];
  cancelled: string[];
  failed: Array<{ id: string; reason: string }>;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function authError(err: unknown): CLIResponse<never> | null {
  if (err instanceof ClobAuthError) return wrapError('orders', 'AUTH', err.message);
  return null;
}

export async function handleOrders(_args: ParsedArgs): Promise<CLIResponse<OrdersData>> {
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
    const orders: OrderView[] = page.items.map((o) => {
      const size = num(o.originalSize);
      const filled = num(o.sizeMatched);
      const createdAt = Date.parse(o.createdAt ?? '');
      return {
        id: o.id,
        market: o.conditionId,
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
    return wrapSuccess('orders', { orders, address: client.account.wallet });
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
export async function handleCancelOrders(args: ParsedArgs): Promise<CLIResponse<CancelData>> {
  const ids = args.positionalArgs.filter((a) => a.trim().length > 0);
  if (ids.length === 0 && !args.all) {
    return wrapError(
      'cancel',
      'MISSING_ARG',
      'Usage: cancel <order-id> [<order-id> …], or cancel --all to cancel every resting order.',
    );
  }

  let client;
  try {
    client = await getClobClient();
  } catch (err) {
    return authError(err) ?? wrapError('cancel', 'AUTH', err instanceof Error ? err.message : String(err));
  }

  try {
    const response = args.all ? await client.cancelAll() : await client.cancelOrders({ orderIds: ids });
    // The CLOB reports per-order outcomes; an id that was already filled or
    // gone is reported rather than silently counted as cancelled.
    const cancelled: string[] = response?.canceled ?? [];
    const failed = Object.entries(response?.notCanceled ?? {}).map(([id, reason]) => ({
      id,
      reason: String(reason),
    }));
    return wrapSuccess('cancel', { requested: args.all ? cancelled : ids, cancelled, failed });
  } catch (err) {
    return wrapError('cancel', 'CLOB_ERROR', err instanceof Error ? err.message : String(err));
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatOrdersHuman(data: OrdersData): string {
  if (data.orders.length === 0) {
    return [
      '  No resting orders.',
      theme.muted('  Orders you place stay here until they fill, expire, or you cancel them.'),
    ].join('\n');
  }

  const rows = data.orders.map((o) => [
    truncate(o.id, 20),
    truncate(o.market, 40),
    o.side,
    truncate(o.outcome, 14),
    `$${o.price.toFixed(2)}`,
    o.remaining.toFixed(2),
    o.filled > 0 ? `${o.filled.toFixed(2)}/${o.size.toFixed(2)}` : '-',
    o.status,
  ]);

  return [
    `  ${data.orders.length} resting order(s)`,
    '',
    formatTable(['Order', 'Market', 'Side', 'Outcome', 'Price', 'Remaining', 'Filled', 'Status'], rows),
    '',
    theme.muted('  Cancel one with: polymarket cancel <order-id>'),
  ].join('\n');
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
