import type { CommandIntent } from './parser.js';
import type { AlertRouter } from '../alerts/router.js';
import type { ParsedArgs } from '../../commands/parse-args.js';
import { handleScan } from '../../commands/scan.js';
import { handleEdge } from '../../commands/edge.js';
import { TRADING_UNAVAILABLE_MESSAGE } from '../../tools/polymarket/polymarket-trade.js';
import {
  formatScanForWhatsApp,
  formatEdgeForWhatsApp,
  formatPortfolioForWhatsApp,
} from './wa-formatters.js';

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'chat',
    positionalArgs: [],
    json: false,
    live: false,
    refresh: false,
    report: false,
    dryRun: false,
    verbose: false,
    performance: false,
    resolved: false,
    unresolved: false,
    behavioral: false,
    ranked: false,
    showCluster: false,
    activeOnly: false,
    cells: false,
    autoProbs: false,
    parseErrors: [],
    ...overrides,
  };
}

export async function handleCommand(
  intent: CommandIntent,
  alertRouter: AlertRouter,
  sessionKey: string,
): Promise<string | null> {
  switch (intent.type) {
    case 'none':
      return null;

    case 'scan': {
      const args = makeArgs({ theme: intent.theme });
      const result = await handleScan(args);
      if (!result.ok) return `Scan failed: ${result.error?.message ?? 'unknown error'}`;
      return formatScanForWhatsApp(result.data);
    }

    case 'edge': {
      const args = makeArgs({ subcommand: 'edge', ticker: intent.ticker });
      const result = await handleEdge(args);
      if (!result.ok) return `Edge failed: ${result.error?.message ?? 'unknown error'}`;
      return formatEdgeForWhatsApp(result.data);
    }

    // Account reads need a configured wallet, which is part of the trading
    // setup that does not exist yet.
    case 'portfolio':
      return TRADING_UNAVAILABLE_MESSAGE;

  }
}
