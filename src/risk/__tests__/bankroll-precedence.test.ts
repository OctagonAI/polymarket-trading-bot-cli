import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { fetchLiveBankroll } from '../kelly.js';
import * as polyPortfolio from '../../tools/polymarket/portfolio.js';
import * as erc20 from '../../chain/erc20.js';
import * as botConfig from '../../utils/bot-config.js';

/**
 * Two sources of bankroll that mean different things, and the arithmetic that
 * combines them.
 *
 *   walletCash  free pUSD on-chain. ALREADY net of open positions, because
 *               positions are outcome tokens rather than encumbered cash.
 *   cap         `risk.bankroll_usdc`. A ceiling on total risk. Static, so it
 *               does not fall as cash is spent.
 *
 *     available = min( walletCash , cap - openExposure )
 *
 * The two failure modes this pins: subtracting openExposure from walletCash
 * double-counts and shrinks sizing as you trade, and NOT subtracting it from the
 * cap lets a ceiling of 1,000 be deployed twice.
 */

const WALLET = '0x' + '1'.repeat(40);
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function setup(opts: {
  wallet?: string;
  cash?: number | null;
  cap?: number;
  positions?: Array<{ current_value: number }>;
  portfolioValue?: number;
}) {
  const realGetBotSetting = botConfig.getBotSetting;
  spies.push(
    spyOn(polyPortfolio, 'getWalletAddress').mockImplementation(() =>
      'wallet' in opts ? opts.wallet : WALLET,
    ),
    spyOn(erc20, 'readPusdBalance').mockImplementation(async () => opts.cash ?? null),
    spyOn(polyPortfolio, 'fetchPortfolioValue').mockImplementation(async () => ({
      portfolio_value: opts.portfolioValue ?? 0,
      address: WALLET,
    })),
    spyOn(polyPortfolio, 'fetchPositions').mockImplementation(
      async () => (opts.positions ?? []) as never,
    ),
    spyOn(botConfig, 'getBotSetting').mockImplementation((key: string) =>
      key === 'risk.bankroll_usdc' ? (opts.cap ?? 0) : realGetBotSetting(key),
    ),
  );
}

describe('bankroll precedence', () => {
  test('wallet only: the balance is the bankroll, with no exposure subtracted', async () => {
    // The double-subtraction trap. On-chain cash already excludes the $300 of
    // positions; subtracting again would size against $100.
    setup({ cash: 400, positions: [{ current_value: 300 }] });
    const b = await fetchLiveBankroll();

    expect(b.walletCash).toBe(400);
    expect(b.availableBankroll).toBe(400);
    expect(b.openExposure).toBe(300);
    expect(b.bankrollSource).toBe('wallet');
    expect(b.bankrollUnset).toBe(false);
  });

  test('no wallet at all: the cap is the bankroll, since positions are unknowable', async () => {
    // Without an address there is nothing to query, so open exposure is not
    // merely zero — it is unknown, and the cap is all there is to go on.
    setup({ wallet: undefined, cap: 1000, positions: [{ current_value: 300 }] });
    const b = await fetchLiveBankroll();

    expect(b.walletCash).toBeNull();
    // Not zero: with no address there is nothing to query, so exposure is
    // genuinely unknown and the cap is all there is to go on.
    expect(b.openExposure).toBeNull();
    expect(b.positionsUnavailable).toBe(true);
    expect(b.availableBankroll).toBe(1000);
    expect(b.bankrollSource).toBe('config');
  });

  test('wallet present but cash unreadable: the cap nets off known exposure', async () => {
    // A watch wallet with the RPC down. Positions still come from the Data API,
    // so exposure IS known and the cap must account for it.
    setup({ cash: null, cap: 1000, positions: [{ current_value: 300 }] });
    const b = await fetchLiveBankroll();

    expect(b.walletCash).toBeNull();
    expect(b.openExposure).toBe(300);
    expect(b.availableBankroll).toBe(700);
  });

  test('both: the lower of the two wins', async () => {
    // A cap above the balance cannot conjure money.
    setup({ cash: 400, cap: 5000 });
    expect((await fetchLiveBankroll()).availableBankroll).toBe(400);

    for (const s of spies.splice(0)) s.mockRestore();

    // A cap below the balance is a real limit.
    setup({ cash: 5000, cap: 400 });
    const b = await fetchLiveBankroll();
    expect(b.availableBankroll).toBe(400);
    expect(b.bankrollSource).toBe('capped');
  });

  test('both, with exposure: the cap still nets off what is deployed', async () => {
    // Wallet says $900 free; the cap says never risk more than $1,000 total and
    // $300 is already at risk. The binding constraint is the cap.
    setup({ cash: 900, cap: 1000, positions: [{ current_value: 300 }] });
    expect((await fetchLiveBankroll()).availableBankroll).toBe(700);
  });

  test('neither: unset, rather than a bankroll of zero', async () => {
    setup({ wallet: undefined, cap: 0 });
    const b = await fetchLiveBankroll();

    expect(b.bankrollUnset).toBe(true);
    expect(b.bankrollSource).toBe('none');
    expect(b.availableBankroll).toBe(0);
  });

  test('an unreadable balance falls back to the cap instead of reporting zero', async () => {
    // RPC down with a cap configured. Sizing should continue against the cap,
    // not collapse to nothing — and walletCash must stay null so the equity
    // maths records "unknown" rather than "wiped out".
    setup({ cash: null, cap: 1000 });
    const b = await fetchLiveBankroll();

    expect(b.walletCash).toBeNull();
    expect(b.equity).toBeNull();
    expect(b.availableBankroll).toBe(1000);
    expect(b.bankrollSource).toBe('config');
  });

  test('an unreadable balance with no cap is unset, not zero', async () => {
    setup({ cash: null, cap: 0 });
    const b = await fetchLiveBankroll();
    expect(b.bankrollUnset).toBe(true);
  });

  test('a cap fully consumed by open positions floors at zero, never negative', async () => {
    setup({ cash: null, cap: 100, positions: [{ current_value: 500 }] });
    expect((await fetchLiveBankroll()).availableBankroll).toBe(0);
  });

  test('equity is cash plus position value, and only when cash is known', async () => {
    setup({ cash: 400, portfolioValue: 600 });
    expect((await fetchLiveBankroll()).equity).toBe(1000);

    for (const s of spies.splice(0)) s.mockRestore();

    setup({ cash: null, cap: 1000, portfolioValue: 600 });
    expect((await fetchLiveBankroll()).equity).toBeNull();
  });

  test('cashBalance prefers the real balance over the configured stand-in', async () => {
    setup({ cash: 400, cap: 1000 });
    expect((await fetchLiveBankroll()).cashBalance).toBe(400);

    for (const s of spies.splice(0)) s.mockRestore();

    setup({ cash: null, cap: 1000 });
    expect((await fetchLiveBankroll()).cashBalance).toBe(1000);
  });
});
