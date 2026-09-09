import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi, num } from './api.js';
import { formatToolResult } from '../types.js';
import type { PolymarketBalance, PolymarketPosition } from './types.js';

/**
 * Read-only portfolio access needs only a wallet address — no signing. Note this
 * is the *proxy* wallet that holds funds, which for most Polymarket users is not
 * the same as the signing EOA.
 *
 * DELIBERATELY DISABLED until the wallet/trading phase.
 *
 * Reading the env var here would re-enable the whole account path — not just the
 * `portfolio` command, which is gated, but `fetchLiveBankroll`, which the scan
 * loop calls on every pass. That feeds `CircuitBreaker.snapshot`, where
 * `drawdown = (highWaterMark - portfolioValue) / highWaterMark` is computed from
 * mark-to-market position value with no cash term, because Polymarket exposes no
 * free-USDC balance. Closing positions then reads as a ~100% drawdown while
 * capital is intact, `drawdown_max` keeps it as a running maximum, and every
 * later `analyze` fails its drawdown gate.
 *
 * Returning undefined unconditionally makes `portfolioValue` always 0, so the
 * high-water mark stays 0 and the drawdown branch is never taken. Defining
 * drawdown properly is part of the wallet work; until then this is off rather
 * than latent, and POLYMARKET_WALLET_ADDRESS is not advertised anywhere.
 *
 * To re-enable, restore the read:
 *
 *   const addr = process.env.POLYMARKET_WALLET_ADDRESS?.trim();
 *   return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : undefined;
 */
export function getWalletAddress(): string | undefined {
  return undefined;
}

export function requireWalletAddress(): string {
  const addr = getWalletAddress();
  if (!addr) {
    throw new Error(
      'Portfolio reads are not available yet: they need a configured wallet, ' +
        'which arrives with trading support.'
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
  for (let page = 0; page < POSITIONS_MAX_PAGES; page++) {
    const batch = await fetchPage(POSITIONS_PAGE_SIZE, page * POSITIONS_PAGE_SIZE);
    all.push(...batch);
    if (batch.length < POSITIONS_PAGE_SIZE) break;
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

export const getBalance = new DynamicStructuredTool({
  name: 'get_balance',
  description:
    'Get total Polymarket portfolio value (mark-to-market of open positions) for the configured wallet. Free USDC balance is on-chain and not included.',
  schema: z.object({}),
  func: async () => formatToolResult({ balance: await fetchPortfolioValue() }),
});
