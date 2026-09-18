import { fetchExchangeStatus } from '../tools/polymarket/exchange.js';
import { TRADING_UNAVAILABLE_MESSAGE, commandUnavailableReason } from '../tools/polymarket/polymarket-trade.js';
import { formatExchangeStatus } from './formatters.js';
import { handleThemes, formatThemesHuman } from './themes.js';
import type { ParsedArgs, Subcommand } from './parse-args.js';

function defaultArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    subcommand: 'chat', positionalArgs: [], json: false,
    live: false, refresh: false, report: false, dryRun: false,
    verbose: false, performance: false, resolved: false,
    unresolved: false,
    activeOnly: false,
    force: false,
    yes: false,
    all: false,
    parseErrors: [],
    ...overrides,
  };
}
import { handleBacktest, formatBacktestHuman } from './backtest.js';
import { handleAnalyze, formatAnalyzeHuman } from './analyze.js';
import { buildHelp } from './help.js';
import { trackEvent } from '../utils/telemetry.js';
import { parseArgs } from './parse-args.js';
import { handleSimilar, formatSimilarHuman } from './similar.js';
import { handleWallet, formatWalletHuman } from './wallet.js';
import { handlePortfolio, formatPortfolioHuman } from './portfolio.js';
import { handleOrders, handleCancelOrders, formatOrdersHuman, formatCancelHuman } from './orders.js';
import { prepareTrade, submitTrade, formatTradeHuman, type PreparedTrade } from './trade.js';
import { handleEvents, formatEventsHuman } from './events.js';
import { handleTrust, formatTrustHuman } from './trust.js';
import { handleReport, formatReportHuman } from './report.js';
import { handleCatalysts, formatCatalystsHuman } from './catalysts.js';

/**
 * The `search themes` category listing, for the TUI.
 *
 * Exported because `/search themes` used to reach this by calling the `/themes`
 * slash command, which routed to the editorial registry instead — a different
 * feature that no longer exists. Calling the listing directly removes the
 * indirection that made that possible.
 */
export async function renderThemesList(): Promise<string> {
  const resp = await handleThemes(parseArgs(['search', 'themes']));
  return resp.ok ? formatThemesHuman(resp.data) : (resp.error?.message ?? 'themes failed');
}


export interface CommandResult {
  output: string;
  /**
   * A signed, unsent order awaiting the user's yes.
   *
   * The TUI cannot prompt on stdin — it holds the terminal in raw mode, and a
   * second reader corrupts the input stream — so the order is prepared here,
   * previewed, and submitted from the TUI's own input loop.
   */
  pendingTrade?: {
    prepared: PreparedTrade;
    action: 'buy' | 'sell';
    outcome: string;
  };
  /** If set, run this async function after showing `output` and append the result */
  asyncFollowUp?: () => Promise<string>;
}

export async function handleSlashCommand(input: string): Promise<CommandResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);
  // Enrich commands with subview/mode flags so analytics can distinguish e.g.
  // a ticker-anchored /similar from a query-anchored one. Outer command name is
  // always tracked.
  const slashMeta: Record<string, string | boolean> = { command: command ?? '' };
  if (command === 'wallet') {
    const sub = args[0]?.toLowerCase();
    // Sub-verb only. An address or key must never reach telemetry.
    if (sub === 'create' || sub === 'import' || sub === 'address' || sub === 'show' || sub === 'approve') {
      slashMeta.subview = sub;
    }
  }
  if (command === 'similar') {
    slashMeta.anchor = args.includes('-q') || args.includes('--query') ? 'query' : 'ticker';
  } else if (command === 'search') {
    slashMeta.remote = !!process.env.OCTAGON_API_KEY;
  }
  trackEvent('slash_command', slashMeta);

  switch (command) {
    case 'help': {
      const result = buildHelp('slash', args[0]);
      return { output: 'error' in result ? result.error : result.text };
    }

    // ─── /portfolio (with subviews) ──────────────────────────────────
    case 'portfolio':
      return handlePortfolioSlash(args[0]);

    // Hidden aliases → /portfolio <subview>
    case 'status':
      return handlePortfolioSlash('status');
    case 'balance':
      return handlePortfolioSlash('balance');
    case 'positions':
      return handlePortfolioSlash('positions');

    // ─── Trading ─────────────────────────────────────────────────────
    case 'buy':
      return handleTradeCommand('buy', args);
    case 'sell':
      return handleTradeCommand('sell', args);
    // ─── /analyze ────────────────────────────────────────────────────
    case 'analyze':
      return handleAnalyzeCommand(args);

    // ─── /review ─────────────────────────────────────────────────────
    case 'review':
      return handleReviewCommand();

    // ─── /backtest ───────────────────────────────────────────────────
    case 'backtest': {
      // Parse backtest-specific flags from slash command args
      const btArgs: Partial<ParsedArgs> = { subcommand: 'backtest' };
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--resolved') btArgs.resolved = true;
        else if (a === '--unresolved') btArgs.unresolved = true;
        else if (a === '--category') btArgs.category = args[++i];
        else if (a === '--days') { const v = Number(args[++i]); if (Number.isFinite(v) && v > 0) btArgs.days = v; }
        else if (a === '--max-age') { const v = Number(args[++i]); if (Number.isFinite(v) && v > 0) btArgs.maxAge = v; }
        else if (a === '--min-edge') { const v = Number(args[++i]?.replace('%', '')); if (Number.isFinite(v)) btArgs.minEdge = v / 100; }
        else if (a === '--min-volume') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0) btArgs.minVolume = v; }
        else if (a === '--min-price') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0 && v <= 100) btArgs.minPrice = v; }
        else if (a === '--max-price') { const v = Number(args[++i]); if (Number.isFinite(v) && v >= 0 && v <= 100) btArgs.maxPrice = v; }
        else if (a === '--export') { const v = args[++i]; if (v) btArgs.exportPath = v; }
        else if (a === '--universe') { const v = args[++i]; if (v === 'api' || v === 'local') btArgs.backtestUniverse = v; }
        else if (a === '--fees') { const v = args[++i]; if (v === 'none' || v === 'taker' || v === 'maker') btArgs.backtestFees = v; }
      }
      // Mirror parse-args' mutual-exclusion check — the slash parser above
      // accepts both flags independently, which would put btArgs in a
      // conflicting state before handleBacktest could see it.
      if (btArgs.resolved && btArgs.unresolved) {
        return { output: 'Error: --resolved and --unresolved cannot be used together.' };
      }
      const mode = btArgs.resolved ? 'resolved markets' : btArgs.unresolved ? 'open markets' : 'resolved + open markets';
      const daysLabel = btArgs.days ?? 15;
      return {
        output: `Running ${daysLabel}-day backtest on ${mode}...`,
        asyncFollowUp: async () => {
          const resp = await handleBacktest(defaultArgs(btArgs));
          if (!resp.ok || !resp.data) return resp.error?.message ?? 'Backtest failed';
          const text = formatBacktestHuman(resp.data, { minEdge: btArgs.minEdge ?? 0.005 });
          return btArgs.exportPath
            ? `${text}\n\nExported per-market detail to ${btArgs.exportPath}`
            : text;
        },
      };
    }

    // ─── Octagon Kalshi search/clusters/basket ───────────────────────
    case 'similar': {
      const parsed = parseArgs(['similar', ...args]);
      return {
        output: 'Querying Octagon for similar markets...',
        asyncFollowUp: async () => {
          const resp = await handleSimilar(parsed);
          return resp.ok ? formatSimilarHuman(resp.data) : (resp.error?.message ?? 'similar failed');
        },
      };
    }
    case 'orders': {
      // `cancel` is a verb on the orders resource, not a command of its own.
      if (args[0]?.toLowerCase() === 'cancel') {
        const parsed = parseArgs(['orders', ...args.slice(1)]);
        return {
          output: 'Cancelling...',
          asyncFollowUp: async () => {
            const resp = await handleCancelOrders(parsed);
            return resp.ok ? formatCancelHuman(resp.data) : (resp.error?.message ?? 'cancel failed');
          },
        };
      }
      const parsed = parseArgs(['orders', ...args]);
      return {
        output: 'Loading orders...',
        asyncFollowUp: async () => {
          const resp = await handleOrders(parsed);
          return resp.ok ? formatOrdersHuman(resp.data) : (resp.error?.message ?? 'orders failed');
        },
      };
    }
    case 'wallet': {
      const parsed = parseArgs(['wallet', ...args]);
      const sub = parsed.positionalArgs[0] ?? 'show';
      return {
        output: `Running wallet ${sub}...`,
        asyncFollowUp: async () => {
          const resp = await handleWallet(parsed);
          return resp.ok ? formatWalletHuman(resp.data) : (resp.error?.message ?? 'wallet failed');
        },
      };
    }
    case 'events': {
      const parsed = parseArgs(['events', ...args]);
      return {
        output: 'Querying Octagon events...',
        asyncFollowUp: async () => {
          const resp = await handleEvents(parsed);
          return resp.ok ? formatEventsHuman(resp.data) : (resp.error?.message ?? 'events failed');
        },
      };
    }
    case 'trust': {
      const parsed = parseArgs(['trust', ...args]);
      return {
        output: 'Fetching Trader Trust scorecard...',
        asyncFollowUp: async () => {
          const resp = await handleTrust(parsed);
          return resp.ok ? formatTrustHuman(resp.data) : (resp.error?.message ?? 'trust failed');
        },
      };
    }
    case 'report': {
      const parsed = parseArgs(['report', ...args]);
      // Reject unknown / malformed flags before kicking off the Octagon call
      // (network round-trip + 3 credits on --refresh). dispatch.ts does the
      // same for the CLI path; slash command path needs its own guard.
      if (parsed.parseErrors.length > 0) {
        return { output: parsed.parseErrors.join('; ') };
      }
      return {
        output: parsed.refresh ? 'Refreshing Octagon report...' : 'Fetching Octagon report...',
        asyncFollowUp: async () => {
          const resp = await handleReport(parsed);
          return resp.ok ? formatReportHuman(resp.data) : (resp.error?.message ?? 'report failed');
        },
      };
    }
    case 'catalysts': {
      const parsed = parseArgs(['catalysts', ...args]);
      return {
        output: 'Loading upcoming catalysts...',
        asyncFollowUp: async () => {
          const resp = await handleCatalysts(parsed);
          return resp.ok ? formatCatalystsHuman(resp.data) : (resp.error?.message ?? 'catalysts failed');
        },
      };
    }

    case 'config':
      // Fall through to agent — better handled by the LLM
      return null;

    default:
      return null;
  }
}

export async function executePendingTrade(trade: NonNullable<CommandResult['pendingTrade']>): Promise<string> {
  // The order was signed when it was prepared; the user has now said yes, so
  // this is the submit half and nothing is re-parsed or re-priced.
  const resp = await submitTrade(trade.prepared);
  return resp.ok ? formatTradeHuman(resp.data) : (resp.error?.message ?? `${trade.action} failed`);
}

// ─── Portfolio subview handler ──────────────────────────────────────────────

/**
 * `/status` checks setup and CLOB reachability and needs no wallet, so it is
 * always available. Every other subview reads an account and therefore needs at
 * least an address — reporting an empty portfolio for someone with no wallet
 * would look exactly like a real, empty account.
 */
async function handlePortfolioSlash(subview?: string): Promise<CommandResult> {
  const view = subview?.toLowerCase() ?? 'overview';
  if (view !== 'status') {
    const unavailable = commandUnavailableReason('portfolio');
    if (unavailable) return { output: unavailable };
    const parsed = parseArgs(['portfolio', ...(subview ? [subview] : [])]);
    return {
      output: 'Loading portfolio...',
      asyncFollowUp: async () => {
        const resp = await handlePortfolio(parsed);
        return resp.ok ? formatPortfolioHuman(resp.data, resp.meta?.warnings ?? []) : (resp.error?.message ?? 'portfolio failed');
      },
    };
  }
  try {
    const data = await fetchExchangeStatus();
    return { output: formatExchangeStatus(data as unknown as Record<string, unknown>) };
  } catch (err) {
    return { output: `Status error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Analyze ────────────────────────────────────────────────────────────────

async function handleAnalyzeCommand(args: string[]): Promise<CommandResult> {
  const ticker = args[0];
  if (!ticker) return { output: 'Usage: /analyze <ticker> [refresh]' };
  const refresh = args[1]?.toLowerCase() === 'refresh';
  try {
    const data = await handleAnalyze(ticker.toUpperCase(), refresh);
    return { output: formatAnalyzeHuman(data) };
  } catch (err) {
    return { output: `Analyze failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Trade command ──────────────────────────────────────────────────────────

function parseSide(val: string | undefined): 'yes' | 'no' | null {
  const v = val?.toLowerCase();
  if (v === 'yes' || v === 'y') return 'yes';
  if (v === 'no' || v === 'n') return 'no';
  return null;
}

/**
 * Argument shape lives in `prepareTrade`, so the TUI and the CLI cannot drift
 * apart on what `/buy 10 0.42 no` means.
 *
 * `--yes` submits without asking, matching the CLI. Otherwise this returns the
 * preview and a signed order, and the TUI collects the answer itself.
 */
async function handleTradeCommand(action: 'buy' | 'sell', args: string[]): Promise<CommandResult> {
  const parsed = parseArgs([action, ...args]);
  const result = await prepareTrade(action, parsed);
  if (!result.ok) {
    return { output: result.response.error?.message ?? `${action} failed` };
  }

  if (parsed.yes) {
    const resp = await submitTrade(result.prepared);
    return { output: resp.ok ? formatTradeHuman(resp.data) : (resp.error?.message ?? `${action} failed`) };
  }

  return {
    output: result.prepared.preview,
    pendingTrade: {
      prepared: result.prepared,
      action,
      outcome: result.prepared.built.outcomeLabel,
    },
  };
}

/** Reads open positions, so it needs the wallet trading setup provides. */
async function handleReviewCommand(): Promise<CommandResult> {
  return { output: TRADING_UNAVAILABLE_MESSAGE };
}

