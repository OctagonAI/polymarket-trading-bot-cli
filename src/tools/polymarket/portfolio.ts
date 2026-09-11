import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi, num } from './api.js';
import { logger } from '../../utils/logger.js';
import { loadWalletIdentity } from '../../wallet/identity.js';
import { readPusdBalance } from '../../chain/erc20.js';
import { formatToolResult } from '../types.js';
import type { PolymarketBalance, PolymarketPosition } from './types.js';

/**
 * Read-only portfolio access needs only an address — no signing.
 *
 * This is the *funding* (proxy) wallet, which for every Polymarket user is a
 * different address from the signing EOA. Querying the EOA returns an empty
 * account, so the distinction is not cosmetic.
 *
 * Re-enabled now that drawdown is measured on equity rather than on position
 * value alone. The previous hard-disable existed because `fetchLiveBankroll`
 * runs on every scan pass and fed a drawdown formula with no cash term, so
 * closing a position read as a ~100% drawdown and latched. That formula is gone
 * (see `CircuitBreaker.snapshot`), and an unreadable balance now records a null
 * equity rather than a zero.
 */
export function getWalletAddress(): string | undefined {
  return loadWalletIdentity().address;
}

/** True when a signing key is available, i.e. orders can be placed. */
export function canSign(): boolean {
  return loadWalletIdentity().tier === 'trade';
}

/**
 * Throws unless a signing key is configured. For the order path only — reads
 * work at the watch tier and must not call this.
 */
export function requireSigner(): string {
  const id = loadWalletIdentity();
  if (id.tier !== 'trade') {
    throw new Error(
      id.tier === 'watch'
        ? `This wallet is watch-only (${id.address}). Run \`polymarket wallet import <private-key> --force\` to place orders.`
        : 'No wallet configured. Run `polymarket wallet create` or `polymarket wallet import <private-key>`.',
    );
  }
  return id.signer!;
}

export function requireWalletAddress(): string {
  const addr = getWalletAddress();
  if (!addr) {
    throw new Error(
      'No wallet configured. Run `polymarket wallet create` for a new one, or ' +
        '`polymarket wallet import <address>` to read an existing account.'
    );
  }
  return addr;
}

type RawPosition = Record<string, unknown>;

export function normalizePosition(raw: RawPosition): PolymarketPosition {
  return {
    ticker: String(raw.slug ?? ''),
    condition_id: String(raw.conditionId ?? ''),
    event_ticker: String(raw.eventSlug ?? ''),
    token_id: String(raw.asset ?? ''),
    outcome: String(raw.outcome ?? ''),
    title: String(raw.title ?? ''),
    size: num(raw.size),
    avg_price: num(raw.avgPrice),
    cur_price: num(raw.curPrice),
    current_value: num(raw.currentValue),
    initial_value: num(raw.initialValue),
    cash_pnl: num(raw.cashPnl),
    percent_pnl: num(raw.percentPnl),
    realized_pnl: num(raw.realizedPnl),
    redeemable: raw.redeemable === true,
  };
}

/** Data API page size cap for /positions. */
const POSITIONS_PAGE_SIZE = 100;
/** Guard against an unbounded loop if the API ever stops shortening pages. */
const POSITIONS_MAX_PAGES = 20;

/**
 * Fetch a wallet's positions, paging until a short page comes back.
 *
 * The Data API caps a page at 100 and takes an `offset`; a single unpaged call
 * silently truncates any wallet holding more than that, which understates
 * `openExposure` in Kelly sizing and drops positions from portfolio reviews.
 *
 * An explicit `opts.limit` is honoured as a single-page maximum, for callers
 * that genuinely want just the first N.
 *
 * The walk stops at POSITIONS_MAX_PAGES. A wallet holding more than
 * POSITIONS_PAGE_SIZE * POSITIONS_MAX_PAGES positions is therefore returned
 * incomplete, which would understate `openExposure` in risk snapshots. That is
 * accepted rather than paged without limit, but it is never silent: the cap is
 * logged as a warning naming the number of pages read. Revisit if real wallets
 * approach it.
 */
export async function fetchPositions(
  wallet = requireWalletAddress(),
  opts: { limit?: number; redeemable?: boolean } = {}
): Promise<PolymarketPosition[]> {
  const fetchPage = async (limit: number, offset: number) => {
    const raw = await callPolymarketApi<RawPosition[]>('data', 'GET', '/positions', {
      params: { user: wallet, limit, offset, redeemable: opts.redeemable },
    });
    return Array.isArray(raw) ? raw : [];
  };

  if (opts.limit !== undefined) {
    return (await fetchPage(opts.limit, 0)).map(normalizePosition);
  }

  const all: RawPosition[] = [];
  let truncated = false;
  for (let page = 0; page < POSITIONS_MAX_PAGES; page++) {
    const batch = await fetchPage(POSITIONS_PAGE_SIZE, page * POSITIONS_PAGE_SIZE);
    all.push(...batch);
    if (batch.length < POSITIONS_PAGE_SIZE) break;
    // A full final page means the wallet has more than the cap allows.
    if (page === POSITIONS_MAX_PAGES - 1) truncated = true;
  }

  if (truncated) {
    logger.warn(
      `[Polymarket] Position list truncated at ${POSITIONS_MAX_PAGES} pages ` +
        `(${all.length} positions). This wallet holds more; totals derived from ` +
        `this list, including open exposure, are understated.`,
    );
  }

  return all.map(normalizePosition);
}

/**
 * Total mark-to-market value of open positions.
 *
 * Polymarket has no Kalshi-style /portfolio/balance: free USDC lives on-chain and
 * is not exposed here, so this reports position value only.
 */
export async function fetchPortfolioValue(wallet = requireWalletAddress()): Promise<PolymarketBalance> {
  const raw = await callPolymarketApi<Array<Record<string, unknown>>>('data', 'GET', '/value', {
    params: { user: wallet },
  });
  const row = Array.isArray(raw) ? raw[0] : undefined;
  return { portfolio_value: num(row?.value), address: wallet };
}

export const getPositions = new DynamicStructuredTool({
  name: 'get_positions',
  description: 'Get the current Polymarket positions for the configured wallet, with P&L.',
  schema: z.object({
    limit: z.number().optional().describe('Max positions to return (default 100)'),
  }),
  func: async (input) => {
    const positions = await fetchPositions(undefined, { limit: input.limit });
    return formatToolResult({ positions });
  },
});

/**
 * Renamed from `get_balance`, which was actively misleading: it returns
 * mark-to-market position value, so a router asking "what is my balance?" got a
 * number that excludes every dollar of free cash.
 */
export const getPortfolioValue = new DynamicStructuredTool({
  name: 'get_portfolio_value',
  description:
    'Get the mark-to-market value of open Polymarket positions for the configured wallet. '
    + 'This is NOT cash — free collateral is pUSD held on-chain; use get_cash_balance for that.',
  schema: z.object({}),
  func: async () => formatToolResult({ portfolio_value: await fetchPortfolioValue() }),
});

export const getCashBalance = new DynamicStructuredTool({
  name: 'get_cash_balance',
  description:
    'Get free collateral (pUSD) held on-chain by the configured Polymarket funding wallet. '
    + 'Returns null when the balance cannot be read — that means unknown, not zero.',
  schema: z.object({}),
  func: async () => {
    const address = requireWalletAddress();
    const balance = await readPusdBalance(address);
    return formatToolResult({
      address,
      cash_balance: balance,
      symbol: 'pUSD',
      ...(balance === null ? { note: 'Balance could not be read; this is unknown, not zero.' } : {}),
    });
  },
});

/**
 * One call for the whole account: cash, position value, and positions.
 *
 * Exists so the agent does not have to chain three tools and then reason about
 * which of them means "money I can spend". Cash and position value are reported
 * separately and never summed into a single "balance" — that conflation is what
 * made the old `get_balance` misleading.
 */
export const portfolioOverviewTool = new DynamicStructuredTool({
  name: 'portfolio_overview',
  description: 'Portfolio overview: free cash (pUSD), position value, and open positions in one call.',
  schema: z.object({}),
  func: async () => {
    const address = requireWalletAddress();
    const [valueRes, positionsRes, cashRes] = await Promise.allSettled([
      fetchPortfolioValue(address),
      fetchPositions(address),
      readPusdBalance(address),
    ]);

    const warnings: string[] = [];
    if (valueRes.status === 'rejected') warnings.push('Position value unavailable (Data API).');
    if (positionsRes.status === 'rejected') warnings.push('Positions unavailable (Data API).');

    const cashBalance = cashRes.status === 'fulfilled' ? cashRes.value : null;
    const portfolioValue = valueRes.status === 'fulfilled' ? valueRes.value.portfolio_value : null;

    return formatToolResult({
      address,
      cash_balance: cashBalance,
      cash_symbol: 'pUSD',
      portfolio_value: portfolioValue,
      equity: cashBalance !== null && portfolioValue !== null ? cashBalance + portfolioValue : null,
      positions: positionsRes.status === 'fulfilled' ? positionsRes.value : [],
      ...(cashBalance === null ? { cash_note: 'Cash balance could not be read; unknown, not zero.' } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  },
});
