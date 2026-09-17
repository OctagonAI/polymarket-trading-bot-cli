import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { loadWalletIdentity } from '../../wallet/identity.js';

/**
 * Order placement exists as of the order phase. This message now covers only
 * the case where the agent is asked to trade and the wallet cannot sign.
 */
export const TRADING_UNAVAILABLE_MESSAGE =
  'Placing orders needs a wallet with a private key. Run `polymarket wallet import <private-key>` ' +
  'for a new one or `polymarket wallet import <private-key>` to bring your own, fund ' +
  'it with pUSD on polymarket.com first.';

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

/**
 * Everything that needs a signing key.
 *
 * `buy`/`sell` moved here from a not-implemented list once placement shipped;
 * there is no longer any command gated on the feature rather than the wallet.
 */
export const KEY_COMMANDS = ['buy', 'sell', 'cancel', 'orders'] as const;

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
      ? 'No wallet configured, so there is no account to report. Run `polymarket wallet import ' +
          '<private-key>` to trade, or `polymarket wallet import <address>` to read an account.'
      : null;
  }
  if ((KEY_COMMANDS as readonly string[]).includes(name)) {
    const tier = loadWalletIdentity().tier;
    if (tier === 'trade') return null;
    return tier === 'watch'
      ? 'This wallet is watch-only. Orders are authenticated with your private key. ' +
          'Run `polymarket wallet import <private-key> --force` to use them.'
      : 'No wallet configured. Run `polymarket wallet import <private-key>` with the key for ' +
          'your polymarket.com account.';
  }
  return null;
}

export function isCommandAvailable(name: string): boolean {
  return commandUnavailableReason(name) === null;
}

export const POLYMARKET_TRADE_DESCRIPTION = `
Prepare a Polymarket order for the user to place. This tool does NOT place orders.

## When to Use

- The user asks to buy or sell and you have a market slug, a share count, and a side
- Returns the exact command they can run, after checking the wallet can trade

## Important

You cannot place an order. Only the user can, by running the command this returns.
Present it to them; do not claim the trade is done, and do not look for another
tool that would place it — there isn't one.

## When NOT to Use

- Market research, prices, or order books (use polymarket_search instead)
- Portfolio positions or value (use portfolio_overview instead)
- Cancelling: tell the user to run \`polymarket orders\` then \`polymarket orders cancel <id>\`
`.trim();

/**
 * Prepares an order; it cannot place one.
 *
 * The separation is structural on purpose. "Never trade without explicit
 * confirmation" is a prompt instruction, and a prompt instruction is something a
 * model can be argued out of — by a jailbreak, a confusing conversation, or a
 * market description written to read like an instruction. Not giving the agent a
 * code path that spends money is a guarantee instead of a request.
 *
 * The user runs the returned command, which has its own confirmation showing the
 * cost.
 */
export function createPolymarketTrade(_model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'polymarket_trade',
    description: POLYMARKET_TRADE_DESCRIPTION,
    schema: z.object({
      action: z.enum(['buy', 'sell']).describe('Whether to buy or sell'),
      market: z.string().describe('Market slug, e.g. will-btc-hit-100k'),
      shares: z.number().positive().describe('Number of shares'),
      outcome: z.string().optional().describe('yes | no, or an outcome name. Defaults to yes.'),
      price: z.number().optional().describe('Limit price, decimal USD in (0,1). Omit for a market order.'),
    }),
    func: async (input) => {
      const tier = loadWalletIdentity().tier;
      if (tier !== 'trade') {
        return formatToolResult({ error: TRADING_UNAVAILABLE_MESSAGE, available: false });
      }
      const parts = [
        `polymarket ${input.action}`,
        input.market,
        String(input.shares),
        ...(input.price !== undefined ? [String(input.price)] : []),
        input.outcome ?? 'yes',
      ];
      return formatToolResult({
        available: true,
        placed: false,
        command: parts.join(' '),
        order_type: input.price === undefined ? 'market' : 'limit',
        note: 'Not placed. Give the user this command to run — it confirms the cost before sending.',
      });
    },
  });
}
