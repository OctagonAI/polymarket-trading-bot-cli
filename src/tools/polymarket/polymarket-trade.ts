import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

/**
 * Order placement is not implemented yet.
 *
 * Polymarket orders are EIP-712 messages signed with a Polygon key, submitted to
 * the CLOB with derived L2 HMAC credentials — a different model from Kalshi's
 * RSA-signed REST calls, and it additionally needs on-chain USDC/CTF allowances
 * and the right proxy-wallet signature type. That work is a later phase; until
 * then this tool exists so the agent gets a clear refusal instead of silently
 * routing trade intent into a read-only tool.
 */
export const TRADING_UNAVAILABLE_MESSAGE =
  'Trading is not available yet in the Polymarket CLI. Order placement requires ' +
  'EIP-712 wallet signing and on-chain USDC/CTF allowances, which land in a later ' +
  'release. Market data and research work today.';

/**
 * Commands hidden until wallet/trading support lands.
 *
 * `portfolio` is here alongside the order commands because everything it reads —
 * positions, portfolio value, resting orders — hangs off a configured wallet,
 * and configuring that wallet is part of the trading setup that does not exist
 * yet. Without one the command can only report an empty portfolio, so listing it
 * promises an account view the CLI cannot produce.
 *
 * Kept separate from octagon-capabilities.ts: those commands are gated by what
 * Octagon can answer, these by what this CLI can do.
 */
export const TRADING_COMMANDS = ['buy', 'sell', 'cancel', 'portfolio'] as const;

export function isTradingCommand(name: string): boolean {
  return (TRADING_COMMANDS as readonly string[]).includes(name);
}

export const POLYMARKET_TRADE_DESCRIPTION = `
Trade execution for Polymarket. NOT YET AVAILABLE — this tool always returns an error.

## When to Use

Never, for now. Order placement is not implemented. If the user asks to buy, sell,
or cancel, call this tool once so they get an accurate explanation rather than a
guess, then stop.

## When NOT to Use

- Market research, prices, or order books (use polymarket_search instead)
- Portfolio positions or value (use polymarket_search instead)
`.trim();

export function createPolymarketTrade(_model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'polymarket_trade',
    description: POLYMARKET_TRADE_DESCRIPTION,
    schema: z.object({
      query: z.string().describe('The trade the user asked for (recorded for the explanation only)'),
    }),
    func: async () => formatToolResult({ error: TRADING_UNAVAILABLE_MESSAGE, available: false }),
  });
}
