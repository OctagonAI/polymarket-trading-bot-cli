import type { CommandIntent } from './parser.js';
import type { AlertRouter } from '../alerts/router.js';
import type { ParsedArgs } from '../../commands/parse-args.js';
import { handleScan } from '../../commands/scan.js';
import { handleEdge } from '../../commands/edge.js';
import { commandUnavailableReason } from '../../tools/polymarket/polymarket-trade.js';
import { handlePortfolio } from '../../commands/portfolio.js';
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
    activeOnly: false,
    force: false,
    yes: false,
    all: false,
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

    // Account reads need a configured wallet.
    case 'portfolio': {
      const unavailable = commandUnavailableReason('portfolio');
      if (unavailable) return unavailable;
      const resp = await handlePortfolio(makeArgs({ subcommand: 'portfolio' }));
      if (!resp.ok) return resp.error?.message ?? 'portfolio failed';
      // Not `formatPortfolioHuman`: that builds box-drawing tables and colours
      // them with ANSI escapes, which is unreadable in a chat message. The
      // WhatsApp formatter takes no warnings, so they are appended here.
      const warnings = resp.meta?.warnings ?? [];
      const body = formatPortfolioForWhatsApp(resp.data);
      return warnings.length > 0 ? `${body}\n\n${warnings.map((w) => `! ${w}`).join('\n')}` : body;
    }

  }
}
