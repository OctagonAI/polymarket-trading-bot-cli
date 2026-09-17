/**
 * `buy` and `sell` — placing an order.
 *
 * Two safety layers, and they are deliberately different in kind:
 *
 *  **The circuit breaker is a hard stop.** It trips on the daily loss limit or
 *  the drawdown limit, both of which the user set precisely to stop themselves
 *  after a bad run. Letting a manual command walk past that would defeat the
 *  only mechanism in the tool designed to override its operator. `--force` is
 *  the documented, deliberate escape.
 *
 *  **The risk gate is advisory.** Position sizing rules exist to govern the
 *  automated scanner. Someone typing an explicit `buy` has already decided; the
 *  right move is to put the gate's objection in front of them at the moment of
 *  confirmation, not to refuse. So gate failures are shown in the prompt and the
 *  human keeps the call.
 *
 * Nothing is signed before the user confirms, and nothing is confirmed without
 * the cost, the price, and any objections on screen.
 */
import * as readline from 'node:readline';
import { randomUUID } from 'crypto';
import type { ParsedArgs } from './parse-args.js';
import { wrapSuccess, wrapError, type CLIResponse } from './json.js';
import { validateTradeArgs } from './help.js';
import { buildOrder, postOrder, OrderError, type TradeAction } from '../clob/orders.js';
import { ClobAuthError } from '../clob/client.js';
import { checkApprovals, readyToTrade } from '../chain/approvals.js';
import { loadWalletIdentity } from '../wallet/identity.js';
import { resolveMarket } from './analyze.js';
import { getDb } from '../db/index.js';
import { openPosition, reducePosition, getOpenPositionsForTicker } from '../db/positions.js';
import { logTrade } from '../db/trades.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { auditTrail } from '../audit/index.js';
import { theme } from '../theme.js';
import type { PolymarketMarket } from '../tools/polymarket/types.js';

export interface TradeData {
  action: TradeAction;
  market: string;
  outcome: string;
  shares: number;
  price: number;
  notionalUsd: number;
  orderType: 'market' | 'limit';
  orderId: string | null;
  status: string;
  filledShares: number;
  warnings: string[];
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Default side for a binary market when the user omits one. */
function defaultOutcome(market: PolymarketMarket): string {
  const outcomes = market.outcomes ?? [];
  const yes = outcomes.find((o) => o.toLowerCase() === 'yes');
  return yes ?? outcomes[0] ?? 'yes';
}

export async function handleTrade(
  action: TradeAction,
  args: ParsedArgs,
): Promise<CLIResponse<TradeData>> {
  const [slug, sharesArg, ...rest] = args.positionalArgs;

  if (!slug || !sharesArg) {
    return wrapError(
      action,
      'MISSING_ARG',
      `Usage: polymarket ${action} <market-slug> <shares> [price] [outcome]\n` +
        `  price   decimal USD in (0,1). Omit for a market order.\n` +
        `  outcome yes|no, or an outcome name for a multi-outcome market.`,
    );
  }

  // `rest` is [price?, outcome?] but either may be omitted, so decide by shape
  // rather than position: a number is a price, a word is an outcome.
  let priceArg: string | undefined;
  let outcomeArg: string | undefined;
  for (const token of rest) {
    if (/^\d*\.?\d+$/.test(token)) priceArg ??= token;
    else outcomeArg ??= token;
  }

  const parsed = validateTradeArgs(sharesArg, priceArg);
  if ('error' in parsed) return wrapError(action, 'INVALID_ARG', parsed.error);

  const id = loadWalletIdentity();
  if (id.tier !== 'trade' || !id.address) {
    return wrapError(
      action,
      'NO_KEY',
      id.tier === 'watch'
        ? `This wallet is watch-only (${id.address}). Run \`polymarket wallet import <private-key> --force\` to trade.`
        : 'No wallet configured. Run `polymarket wallet import <private-key>` with your polymarket.com key.',
    );
  }

  const db = getDb();
  const warnings: string[] = [];

  // Hard stop. Checked before anything else costs a round trip.
  const breaker = new CircuitBreaker();
  const breakerStatus = breaker.check(db);
  if (breakerStatus.active && !args.force) {
    return wrapError(
      action,
      'CIRCUIT_BREAKER',
      `Circuit breaker is active: ${breakerStatus.reason}. ` +
        'This is the limit you configured to stop trading after a bad run. Pass --force to override.',
    );
  }
  if (breakerStatus.active) warnings.push(`Circuit breaker overridden: ${breakerStatus.reason}`);

  // Approvals: the CLOB rejects an unapproved order with an opaque error, so
  // catch it here where the fix can be named.
  try {
    const statuses = await checkApprovals(id.address);
    if (statuses.some((s) => s.error)) {
      warnings.push('Could not verify on-chain approvals; the order may be rejected.');
    } else if (!readyToTrade(statuses)) {
      return wrapError(
        action,
        'NOT_APPROVED',
        'This wallet has not granted the on-chain approvals trading needs. Run: polymarket wallet approve',
      );
    }
  } catch (err) {
    warnings.push(`Approval check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let market: PolymarketMarket;
  try {
    market = await resolveMarket(slug);
  } catch (err) {
    return wrapError(action, 'NOT_FOUND', err instanceof Error ? err.message : String(err));
  }

  const outcome = outcomeArg ?? defaultOutcome(market);

  // Selling more than you hold is rejected by the venue with an unhelpful
  // message; the local book is not authoritative, so this warns rather than
  // blocks — positions opened outside this CLI are not in it.
  if (action === 'sell') {
    const held = getOpenPositionsForTicker(db, market.ticker)
      .filter((p) => p.direction.toLowerCase() === outcome.toLowerCase())
      .reduce((sum, p) => sum + p.size, 0);
    if (held > 0 && parsed.count > held) {
      warnings.push(`Selling ${parsed.count} but this CLI only tracks ${held} share(s) of ${outcome}.`);
    }
  }

  let built;
  try {
    built = await buildOrder({
      market,
      action,
      outcome,
      shares: parsed.count,
      ...(parsed.price !== undefined ? { limitPrice: parsed.price } : {}),
    });
  } catch (err) {
    if (err instanceof OrderError) return wrapError(action, 'ORDER_INVALID', err.message);
    if (err instanceof ClobAuthError) return wrapError(action, 'AUTH', err.message);
    return wrapError(action, 'ORDER_INVALID', err instanceof Error ? err.message : String(err));
  }

  if (!args.yes) {
    const verb = action === 'buy' ? 'Buy' : 'Sell';
    const kind = built.isMarketOrder ? 'market order — fills now or not at all' : 'limit order — rests on the book';
    const lines = [
      '',
      `  ${verb} ${built.shares} share(s) of ${theme.bold(built.outcomeLabel)}`,
      `  ${market.ticker}`,
      '',
      `    Price     $${built.price.toFixed(2)} per share   ${theme.muted(`(${kind})`)}`,
      `    ${action === 'buy' ? 'Cost ' : 'Value'}     $${built.notionalUsd.toFixed(2)}`,
      `    Wallet    ${id.address}`,
      '',
    ];
    for (const w of warnings) lines.push(theme.error(`    ! ${w}`));
    if (warnings.length > 0) lines.push('');
    console.log(lines.join('\n'));
    if (!(await confirm(`  Place this order? [y/N] `))) {
      return wrapError(action, 'CANCELLED', 'Cancelled. No order was placed.');
    }
  }

  let posted;
  try {
    posted = await postOrder(built);
  } catch (err) {
    if (err instanceof OrderError) return wrapError(action, 'REJECTED', err.message);
    return wrapError(action, 'CLOB_ERROR', err instanceof Error ? err.message : String(err));
  }

  recordFill(action, market, built, posted, parsed.count);

  auditTrail.log({
    type: 'TRADE_EXECUTED',
    ticker: market.ticker,
    order_id: posted.orderId ?? '',
    fill_price: built.price,
    size: built.shares,
    action,
    outcome: built.outcomeLabel,
  });

  return wrapSuccess(action, {
    action,
    market: market.ticker,
    outcome: built.outcomeLabel,
    shares: built.shares,
    price: built.price,
    notionalUsd: built.notionalUsd,
    orderType: built.isMarketOrder ? 'market' : 'limit',
    orderId: posted.orderId,
    status: posted.status,
    filledShares: posted.filledShares,
    warnings,
  });
}

/**
 * Persist what actually filled.
 *
 * Only the matched portion is recorded: an order that rests on the book is not
 * a position yet, and writing it as one would inflate the concentration and
 * correlation checks with exposure that does not exist.
 */
function recordFill(
  action: TradeAction,
  market: PolymarketMarket,
  built: Awaited<ReturnType<typeof buildOrder>>,
  posted: Awaited<ReturnType<typeof postOrder>>,
  requestedShares: number,
): void {
  const filled = posted.filledShares > 0 ? posted.filledShares : built.isMarketOrder ? requestedShares : 0;
  if (filled <= 0) return;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    logTrade(db, {
      trade_id: posted.orderId ?? randomUUID(),
      order_id: posted.orderId ?? null,
      ticker: market.ticker,
      action,
      side: built.outcomeLabel,
      size: filled,
      price: built.price,
      fill_status: posted.status,
      raw_response: JSON.stringify(posted.raw ?? {}),
      created_at: now,
    });

    if (action === 'buy') {
      openPosition(db, {
        position_id: posted.orderId ?? randomUUID(),
        ticker: market.ticker,
        event_ticker: market.event_ticker ?? market.ticker,
        direction: built.outcomeLabel,
        size: filled,
        entry_price: built.price,
        opened_at: now,
        status: 'open',
      });
    } else {
      // Reduce oldest-held first, across however many rows it takes.
      let remaining = filled;
      for (const pos of getOpenPositionsForTicker(db, market.ticker)
        .filter((p) => p.direction.toLowerCase() === built.outcomeLabel.toLowerCase())
        .reverse()) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, pos.size);
        reducePosition(db, pos.position_id, take, now);
        remaining -= take;
      }
    }
  } catch {
    // The order is already placed; a bookkeeping failure must not be reported
    // as a failed trade. `portfolio` reads the venue, so the position is still
    // visible — only the local risk-gate view is affected.
  }
}

export function formatTradeHuman(data: TradeData): string {
  const lines: string[] = [];
  const verb = data.action === 'buy' ? 'Bought' : 'Sold';

  if (data.filledShares > 0) {
    lines.push(theme.success(`  ${verb} ${data.filledShares} share(s) of ${data.outcome}`));
  } else {
    // A resting limit order is not a position. Saying "bought" here would be
    // wrong, and it is the difference the user most needs to see.
    lines.push(`  Order placed — ${data.shares} share(s) of ${data.outcome}, resting on the book.`);
  }

  lines.push(`    ${data.market}`);
  lines.push(`    Price     $${data.price.toFixed(2)} per share (${data.orderType})`);
  lines.push(`    ${data.action === 'buy' ? 'Cost ' : 'Value'}     $${data.notionalUsd.toFixed(2)}`);
  if (data.orderId) lines.push(`    Order     ${data.orderId}`);
  if (data.status && data.status !== 'unknown') lines.push(`    Status    ${data.status}`);

  for (const w of data.warnings) lines.push(theme.error(`    ! ${w}`));

  if (data.filledShares === 0 && data.orderId) {
    lines.push('');
    lines.push(theme.muted(`    Cancel it with: polymarket cancel ${data.orderId}`));
  }
  return lines.join('\n');
}
