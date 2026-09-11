import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { loadWalletIdentity } from '../../wallet/identity.js';

/**
 * Order placement is not implemented yet.
 *
 * Polymarket orders are EIP-712 messages signed with a Polygon key, submitted to
 * the CLOB with derived L2 HMAC credentials — a different model from Kalshi's
 * RSA-signed REST calls, and it additionally needs on-chain pUSD/CTF allowances
 * and the right proxy-wallet signature type.
 *
 * All of that now exists: `src/clob/client.ts` authenticates, `wallet approve`
 * grants the allowances, and `orders` / `cancel` use both. What is missing is
 * order CONSTRUCTION — sizing, tick rounding, and choosing an order type. Until
 * that lands this tool exists so the agent gets a clear refusal instead of
 * silently routing trade intent into a read-only tool.
 */
export const TRADING_UNAVAILABLE_MESSAGE =
  'Order placement is not available yet in the Polymarket CLI. Everything around it ' +
  'is in place — wallet, pUSD balance, on-chain approvals, and `orders` / `cancel` ' +
  'for orders already resting — only placing a new one is missing.';

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
export const TRADING_COMMANDS = ['buy', 'sell', 'cancel', 'orders', 'portfolio'] as const;

/** Placement — not implemented yet at any tier. */
export const ORDER_COMMANDS = ['buy', 'sell'] as const;

/** Implemented, but need a signing key to authenticate against the CLOB. */
export const KEY_COMMANDS = ['cancel', 'orders'] as const;

/** Need an address, but not a key — the watch tier is enough. */
export const ACCOUNT_COMMANDS = ['portfolio'] as const;

export function isTradingCommand(name: string): boolean {
  return (TRADING_COMMANDS as readonly string[]).includes(name);
}

/**
 * Why a command cannot run right now, or null when it can.
 *
 * Availability is a function of wallet state rather than a static list, so a
 * user who configures a wallet sees `portfolio` appear without any further
 * ceremony, and one who only pasted an address is told what is missing instead
 * of being shown an account view full of zeros.
 *
 * Every gate and every hide-from-listing site calls this one function. Leaving
 * some on the static `isTradingCommand` is how the old behaviour would quietly
 * survive in half the surfaces.
 */
export function commandUnavailableReason(name: string): string | null {
  if ((ACCOUNT_COMMANDS as readonly string[]).includes(name)) {
    return loadWalletIdentity().tier === 'none'
      ? 'No wallet configured, so there is no account to report. Run `polymarket wallet create` ' +
          'for a new one, or `polymarket wallet import <address>` to read an existing account.'
      : null;
  }
  if ((KEY_COMMANDS as readonly string[]).includes(name)) {
    const tier = loadWalletIdentity().tier;
    if (tier === 'trade') return null;
    return tier === 'watch'
      ? 'This wallet is watch-only. Orders are authenticated with your private key. ' +
          'Run `polymarket wallet import <private-key> --force` to use them.'
      : 'No wallet configured. Run `polymarket wallet create` or ' +
          '`polymarket wallet import <private-key>`.';
  }
  if ((ORDER_COMMANDS as readonly string[]).includes(name)) {
    // Order placement does not exist yet at any tier, so the reason is the same
    // for everyone. Telling a watch-only user to import a key would imply that
    // doing so unlocks trading, which it does not — the tier check belongs here
    // once orders are actually implemented.
    return TRADING_UNAVAILABLE_MESSAGE;
  }
  return null;
}

export function isCommandAvailable(name: string): boolean {
  return commandUnavailableReason(name) === null;
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
