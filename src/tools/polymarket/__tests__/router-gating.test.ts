import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import * as polyPortfolio from '../portfolio.js';
import { POLYMARKET_SEARCH_DESCRIPTION, polymarketReadToolNames } from '../polymarket-search.js';
import { getTools } from '../../registry.js';

/**
 * The top-level registry withholds the portfolio tools while no wallet is
 * configured, but `polymarket_search` is a meta-tool with its own routable set —
 * and it used to hand `get_balance` and `get_positions` to the router
 * unconditionally, along with prompt lines telling it to use them. Both throw
 * `requireWalletAddress()`, so the gating was bypassed one layer down and the
 * agent could not distinguish that failure from a real outage.
 */

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function withWallet(address: string | undefined) {
  spies.push(spyOn(polyPortfolio, 'getWalletAddress').mockImplementation(() => address));
}

// get_balance was renamed: it returned mark-to-market position value, so a
// router asked for "my balance" got a number excluding every dollar of cash.
const WALLET_TOOL_NAMES = ['get_portfolio_value', 'get_cash_balance', 'get_positions'];

describe('polymarket_search wallet gating', () => {
  test('no wallet: the router is not offered tools that would throw', () => {
    withWallet(undefined);
    const names = polymarketReadToolNames();
    for (const n of WALLET_TOOL_NAMES) expect(names).not.toContain(n);
    // The market-data tools are unaffected — this gates the wallet path only.
    expect(names).toContain('search_events');
    expect(names).toContain('get_market');
  });

  test('wallet configured: the router regains the wallet tools', () => {
    withWallet('0x' + '1'.repeat(40));
    const names = polymarketReadToolNames();
    for (const n of WALLET_TOOL_NAMES) expect(names).toContain(n);
  });

  test('the set is resolved per call, not frozen at module load', () => {
    withWallet(undefined);
    const without = polymarketReadToolNames().length;
    spies.splice(0).forEach((s) => s.mockRestore());
    withWallet('0x' + '2'.repeat(40));
    expect(polymarketReadToolNames().length).toBe(without + WALLET_TOOL_NAMES.length);
  });

  test('no wallet: the top-level registry withholds the portfolio tools', () => {
    withWallet(undefined);
    const names = getTools('test-model').map((t) => t.name);
    expect(names).not.toContain('portfolio_overview');
    expect(names).not.toContain('portfolio_review');
  });

  test('wallet configured: the registry gains portfolio_overview', () => {
    withWallet('0x' + '1'.repeat(40));
    expect(getTools('test-model').map((t) => t.name)).toContain('portfolio_overview');
  });

  test('get_balance is gone — its name claimed cash it never returned', () => {
    withWallet('0x' + '1'.repeat(40));
    expect(polymarketReadToolNames()).not.toContain('get_balance');
  });

  test('the meta-tool description flags that the wallet path is conditional', () => {
    // A blanket "checking wallet positions and portfolio value" reads as an
    // unconditional capability.
    expect(POLYMARKET_SEARCH_DESCRIPTION).toContain('only when a wallet is configured');
  });
});
