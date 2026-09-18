import type { ParsedArgs, Subcommand } from './parse-args.js';
import { wrapSuccess, wrapError } from './json.js';
import type { CLIResponse } from './json.js';
import { handleEdge, formatEdgeHuman } from './edge.js';
import { handleAnalyze, formatAnalyzeHuman, promptAnalyzeActions } from './analyze.js';
import { formatRawReport } from '../controllers/browse.js';
import { handleConfig, formatConfigHuman } from './config.js';
import { handleAlerts, formatAlertsHuman } from './alerts.js';
import { handleStatus } from './status.js';
import { handleThemes, formatThemesHuman } from './themes.js';
import { handleWatch } from './watch.js';
import { handleBacktest, formatBacktestHuman } from './backtest.js';
import { commandUnavailableReason } from '../tools/polymarket/polymarket-trade.js';
import { buildHelp } from './help.js';
import { ensureIndex, forceRefreshIndex } from '../tools/polymarket/search-index.js';
import { searchEventIndex } from '../db/event-index.js';
import { scanEdges, formatEdgeScanHuman } from './search-edge.js';

import { ExitCode, exitCodeFromError } from '../utils/errors.js';
import { trackEvent } from '../utils/telemetry.js';
import { handleSimilar, formatSimilarHuman } from './similar.js';
import { handleWallet, formatWalletHuman } from './wallet.js';
import { handlePortfolio, formatPortfolioHuman } from './portfolio.js';
import { handleOrders, handleCancelOrders, formatOrdersHuman, formatCancelHuman } from './orders.js';
import { handleTrade, formatTradeHuman } from './trade.js';
import { searchOctagonMarkets, searchOctagonEvents, EVENT_SEARCH_TEXT_TIMEOUT_MS, getEventsWithEdge, addVenuePrefix } from '../scan/octagon-api.js';
import { formatMarketSearchHuman, formatEventSearchHuman, formatMarketsWithEdgeHuman, formatEventMarketsHuman, formatIndexEventsHuman } from './search-remote.js';
import { findTheme, parseThemeQuery } from '../scan/theme-registry.js';
import { looksLikeSlug } from './similar.js';
import { handleEvents, formatEventsHuman } from './events.js';
import { handleTrust, formatTrustHuman } from './trust.js';
import { handleReport, formatReportHuman } from './report.js';
import { handleCatalysts, formatCatalystsHuman } from './catalysts.js';

// ─── Alias resolution ────────────────────────────────────────────────────────
// Maps legacy CLI subcommands to canonical commands with mode/subview context

interface ResolvedCommand {
  canonical: Subcommand;
  mode?: string;
  subview?: string;
}

function resolveAlias(subcommand: Subcommand, positionalArgs: string[]): ResolvedCommand {
  switch (subcommand) {
    // Legacy analysis aliases → analyze
    case 'edge':
      return { canonical: 'edge', mode: 'edge-only' };
    // Legacy account aliases → portfolio
    case 'status':
      return { canonical: 'portfolio', subview: 'status' };

    // wallet sub-routing (import/address/show/approve) — telemetry granularity.
    // The sub-verb is recorded; no address or key ever reaches telemetry.
    case 'wallet': {
      const sub = positionalArgs[0]?.toLowerCase();
      if (sub === 'create' || sub === 'import' || sub === 'address' || sub === 'show' || sub === 'approve') {
        return { canonical: 'wallet', subview: sub };
      }
      return { canonical: 'wallet' };
    }

    // orders sub-routing. `cancel` is a verb on the orders resource rather than
    // a top-level command; anything else is an order id or id prefix.
    case 'orders': {
      const sub = positionalArgs[0]?.toLowerCase();
      if (sub === 'cancel') return { canonical: 'orders', subview: 'cancel' };
      return { canonical: 'orders', ...(sub ? { subview: 'detail' } : {}) };
    }

    default:
      return { canonical: subcommand };
  }
}

function modeFlagsFor(canonical: Subcommand, args: ParsedArgs): Record<string, string | boolean> {
  switch (canonical) {
    case 'similar':
      return { anchor: args.ticker ? 'ticker' : args.query ? 'query' : 'positional' };
    case 'search':
      return { remote: !!process.env.OCTAGON_API_KEY };
    default:
      return {};
  }
}

/**
 * One-time stderr hint when a user pipes `--json` through `bunx` without
 * `--silent`. Bunx prints install chatter to stdout *before* our process even
 * starts, which corrupts JSON pipelines — `--silent` fixes it entirely, but
 * users rarely discover that flag on their own. We can't strip the chatter
 * (it's not in our stdout), but we can nudge them once.
 *
 * Heuristic: --json + non-TTY stdout + BUN_INSTALL_CACHE_DIR set (bunx sets
 * this; `bun add -g` installs don't). Silenced after first emit by touching
 * a sentinel file under ~/.polymarket-bot/.
 */
async function maybeEmitBunxHint(args: ParsedArgs): Promise<void> {
  if (!args.json) return;
  if (process.stdout.isTTY) return;
  if (!process.env.BUN_INSTALL_CACHE_DIR) return;
  try {
    // Dynamic ESM imports to avoid pulling these into the module graph at init.
    const { appPath } = await import('../utils/paths.js');
    const { existsSync, writeFileSync, mkdirSync } = await import('fs');
    const sentinel = appPath('.bunx-hint-shown');
    if (existsSync(sentinel)) return;
    process.stderr.write(
      '[polymarket] Tip: for clean JSON output and parallel-safe scripting, install once with\n' +
      '[polymarket]   bun add -g polymarket-trading-bot-cli\n' +
      '[polymarket] then call `polymarket …` directly. Or use `bunx --silent` to suppress install\n' +
      '[polymarket] chatter from this invocation. See README → Scripting & Parallel Use.\n',
    );
    const dir = appPath('.');
    mkdirSync(dir, { recursive: true });
    writeFileSync(sentinel, String(Date.now()));
  } catch {
    // Best-effort hint — never fail the actual command because of it.
  }
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export async function dispatch(args: ParsedArgs): Promise<void> {
  // --days-to-close N is ergonomic sugar over --close-before <iso>. Resolve
  // it once here so every downstream command (search, events, series,
  // catalysts, basket --theme, similar) gets the same filter without each
  // handler reimplementing the arithmetic.
  if (args.daysToClose !== undefined && !args.closeBefore) {
    const target = new Date(Date.now() + args.daysToClose * MILLISECONDS_PER_DAY);
    args.closeBefore = target.toISOString();
  }

  const { subcommand, json } = args;
  const resolved = resolveAlias(subcommand, args.positionalArgs);
  await maybeEmitBunxHint(args);
  trackEvent('cli_command', {
    command: resolved.canonical,
    subview: resolved.subview ?? '',
    ...modeFlagsFor(resolved.canonical, args),
  });

  try {
    // ─── reject invalid flags early (for all commands) ───────────────
    if (args.parseErrors.length > 0) {
      const msg = args.parseErrors.join('; ');
      if (json) {
        console.log(JSON.stringify(wrapError(subcommand, 'INVALID_ARGS', msg)));
        process.exit(ExitCode.USER_ERROR);
      } else {
        console.error(msg);
        process.exit(ExitCode.USER_ERROR);
      }
      return;
    }

    // ─── Commands whose availability depends on wallet state ──────────
    // `portfolio` needs an address; orders additionally need a key. The reason
    // is command- and tier-specific, so it says what is actually missing rather
    // than one blanket "not available". `status` is the exception: it resolves
    // to a portfolio subview for historical reasons but only checks setup and
    // CLOB reachability, neither of which needs a wallet.
    const unavailable =
      resolved.subview === 'status' ? null : commandUnavailableReason(resolved.canonical);
    if (unavailable) {
      if (json) {
        console.log(JSON.stringify(wrapError(resolved.canonical, 'NOT_AVAILABLE', unavailable)));
      } else {
        console.error(unavailable);
      }
      process.exit(ExitCode.USER_ERROR);
      return;
    }

    // ─── search ────────────────────────────────────────────────────────
    if (resolved.canonical === 'search') {
      const sub = resolved.subview ?? args.positionalArgs[0];
      if (sub === 'themes' || resolved.subview === 'themes') {
        const resp = await handleThemes(args);
        if (json) {
          console.log(JSON.stringify(resp));
        } else {
          console.log(formatThemesHuman(resp.data));
        }
        process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
        return;
      }
      if (sub === 'edge') {
        const minEdgePp = (args.minEdge ?? 0.05) * 100;
        if (process.env.OCTAGON_API_KEY) {
          // edge_pp_min is asymmetric (only filters lower bound). Skip when
          // user passes --min-edge 0 so they see the full distribution.
          const data = await getEventsWithEdge({
            category: args.category,
            ...(minEdgePp > 0 ? { edge_pp_min: minEdgePp } : {}),
            sort_by: (args.sortBy as 'edge_pp' | 'expected_return' | 'total_volume' | 'model_probability' | undefined) ?? 'edge_pp',
            limit: args.limit ?? 20,
          });
          if (json) {
            console.log(JSON.stringify(wrapSuccess('search', data)));
          } else {
            console.log(formatMarketsWithEdgeHuman(data, minEdgePp));
          }
          process.exit(ExitCode.SUCCESS);
          return;
        }
        // Local fallback: scan cached Octagon reports in SQLite
        const db = (await import('../db/index.js')).getDb();
        const result = scanEdges(db, { minEdgePp, limit: args.limit, category: args.category });
        if (json) {
          console.log(JSON.stringify(wrapSuccess('search', result)));
        } else {
          console.log(formatEdgeScanHuman(result, minEdgePp));
        }
        process.exit(ExitCode.SUCCESS);
        return;
      }
      if (!sub) {
        // No query provided — show themes as a starting point
        const resp = await handleThemes(args);
        if (json) {
          console.log(JSON.stringify(resp));
        } else {
          console.log(formatThemesHuman(resp.data));
        }
        process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
        return;
      }
      const query = args.positionalArgs.join(' ');

      if (process.env.OCTAGON_API_KEY) {
        // Route by what the user actually typed.
        //
        // Market-level filters only exist on /markets/search, so a query using
        // them stays there (it also keeps the Closes column, which the events
        // route cannot populate). Everything else — a theme name or free text —
        // goes to the event route, because Polymarket market titles are outcome
        // labels ("Yes", "76,000") while the subject lives on the event.
        const usesMarketFilters =
          args.minVolume !== undefined ||
          args.closeBefore !== undefined ||
          args.sortBy !== undefined ||
          args.category !== undefined ||
          args.seriesTicker !== undefined ||
          args.seriesPrefix !== undefined;

        // A slug names one event: list its markets rather than searching for
        // the literal string. Event and market slugs share one namespace shape
        // (fed-decision-in-september-762 vs will-the-fed-...-863), so nothing
        // lexical can tell them apart — resolution decides, and we fall through
        // to search when the event has no markets.
        //
        // This is the same venue-agnostic route the Kalshi CLI drills through,
        // so both surfaces answer from one corpus. It matches `event_ticker`
        // against the namespaced id, never the bare slug the user typed.
        if (!usesMarketFilters && query && looksLikeSlug(query)) {
          const drill = await searchOctagonMarkets({
            event_ticker: addVenuePrefix(query),
            limit: args.limit ?? 30,
          });
          if (drill.data.length > 0) {
            // --active-only is deliberately absent from usesMarketFilters, so it
            // reaches this branch and has to be honoured here exactly as the
            // markets path below does. Filter AFTER the emptiness check: an
            // event whose markets are all inactive should return an empty
            // drill-down, not fall through to a literal slug search that would
            // then match the event by title and print an event row.
            const drillPage = args.activeOnly
              ? { ...drill, data: drill.data.filter((m) => m.status === 'active' || m.status === 'open') }
              : drill;
            if (json) {
              console.log(JSON.stringify(wrapSuccess('search', drillPage)));
            } else {
              console.log(formatEventMarketsHuman(query, drillPage));
            }
            return;
          }
        }

        // `theme:subtheme` (crypto:btc) splits here. findTheme alone is a flat
        // lookup, so the composite string missed and fell through to a literal
        // free-text search for "crypto:btc" — which matches nothing, even
        // though `search themes` advertises the syntax and both `scan` and the
        // TUI honour it.
        const { theme, subtheme } = parseThemeQuery(query);
        // The events route rejects any q term under three characters, and hyphens
        // become spaces before it is sent — so check each term the way the request
        // will, and say so plainly rather than leaking a raw upstream 400.
        if (theme && subtheme && !usesMarketFilters) {
          const tooShort = subtheme
            .replace(/-/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .find((t) => t.length < 3);
          if (tooShort) {
            const msg = `A subtheme must be at least 3 characters ('${tooShort}' is too short). Try: search ${theme.id}`;
            if (json) {
              console.log(JSON.stringify(wrapError('search', 'INVALID_ARGS', msg)));
            } else {
              console.error(msg);
            }
            process.exit(ExitCode.USER_ERROR);
            return;
          }
        }
        if (theme && !usesMarketFilters) {
          // meta_category is case-sensitive and a closed set — it comes from
          // the registry, never from the raw query string. `q` is raw user
          // text and is safe to pass through: it is a search term, not a
          // closed-vocabulary filter. The two AND together.
          const page = await searchOctagonEvents({
            meta_category: theme.metaCategory,
            // Autocomplete offers kebab-cased tags (oil-and-energy); q is full
            // text, so hyphens have to become spaces or it matches nothing.
            ...(subtheme ? { q: subtheme.replace(/-/g, ' ') } : {}),
            limit: args.limit ?? 30,
          });
          const describe = subtheme ? `theme ${theme.id}:${subtheme}` : `theme ${theme.id}`;
          if (json) {
            console.log(JSON.stringify(wrapSuccess('search', page)));
          } else {
            console.log(formatEventSearchHuman(describe, page));
          }
          return;
        }

        // sort_by is server-side (true top-N across the whole universe).
        const serverSortBy = (args.sortBy === 'volume_24h' || args.sortBy === 'close_time' || args.sortBy === 'last_price')
          ? args.sortBy
          : undefined;
        const page = await searchOctagonMarkets({
          q: query,
          category: args.category,
          series_ticker: args.seriesTicker,
          series_prefix: args.seriesPrefix,
          min_volume_24h: args.minVolume,
          close_before: args.closeBefore,
          sort_by: serverSortBy,
          limit: args.limit ?? 30,
        });
        // --active-only is defensive — the live universe is active by default.
        const rows = args.activeOnly
          ? page.data.filter((m) => m.status === 'active' || m.status === 'open')
          : page.data;
        const filteredPage = { ...page, data: rows };

        // Market titles are outcome labels ("Yes", "76,000"), so a query naming
        // the subject — "government shutdown" — matches no market even when the
        // event exists. Retry at event level, but only on a miss: the event
        // route is erratic on high-match free text (q=bitcoin and q=election
        // both exceeded 30s while /markets/search answered in ~1s), and those
        // are exactly the queries this path already answered. Short leash, and
        // a failure leaves the market result standing.
        if (filteredPage.data.length === 0 && !usesMarketFilters) {
          try {
            const events = await searchOctagonEvents(
              { q: query, limit: args.limit ?? 30 },
              { timeoutMs: EVENT_SEARCH_TEXT_TIMEOUT_MS },
            );
            if (events.data.length > 0) {
              if (json) {
                console.log(JSON.stringify(wrapSuccess('search', events)));
              } else {
                console.log(formatEventSearchHuman(`"${query}"`, events));
              }
              return;
            }
          } catch {
            // Slow or unavailable — fall through to the empty market result.
          }
        }

        if (json) {
          console.log(JSON.stringify(wrapSuccess('search', filteredPage)));
        } else {
          console.log(formatMarketSearchHuman(query, filteredPage));
        }
        return;
      }

      // Local fallback: query the pre-built event index.
      if (args.refresh) {
        await forceRefreshIndex();
      } else {
        await ensureIndex();
      }
      const db = (await import('../db/index.js')).getDb();
      // Mirror the TUI: a theme narrows by category, and `theme:subtheme` searches
      // the subtheme within it. Passing the raw string made `crypto:btc` a single
      // keyword that matched nothing, since search_text never contains a colon.
      const { theme: localTheme, subtheme: localSubtheme } = parseThemeQuery(query);
      const results = localTheme
        ? searchEventIndex(db, localSubtheme ?? '', 30, { categoryLabels: localTheme.tags })
        : searchEventIndex(db, query, 30);
      const localDescribe = localTheme
        ? localSubtheme
          ? `theme ${localTheme.id}:${localSubtheme}`
          : `theme ${localTheme.id}`
        : `"${query}"`;
      if (json) {
        console.log(JSON.stringify(wrapSuccess('search', { events: results })));
      } else {
        console.log(formatIndexEventsHuman(localDescribe, results));
      }
      return;
    }

    // ─── status ────────────────────────────────────────────────────────
    // `status` resolves to a portfolio subview for historical reasons. It is the
    // only one still reachable: the trading gate above returns for every other
    // portfolio view, so their handlers were dead code and have been removed.
    // They come back with the wallet phase.
    if (resolved.canonical === 'portfolio' && resolved.subview === 'status') {
      const output = await handleStatus();
      if (json) {
        console.log(JSON.stringify({ ok: true, output }));
      } else {
        console.log(output);
      }
      return;
    }

    if (resolved.canonical === 'buy' || resolved.canonical === 'sell') {
      const resp = await handleTrade(resolved.canonical, args);
      if (json) console.log(JSON.stringify(resp));
      else if (resp.ok) console.log(formatTradeHuman(resp.data));
      else console.error(resp.error?.message ?? `${resolved.canonical} failed`);
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    if (resolved.canonical === 'orders') {
      // `orders cancel <id>` — the verb consumes its own name so the ids that
      // follow are the only positionals the handler sees.
      if (resolved.subview === 'cancel') {
        const rest = { ...args, positionalArgs: args.positionalArgs.slice(1) };
        const resp = await handleCancelOrders(rest);
        if (json) console.log(JSON.stringify(resp));
        else if (resp.ok) console.log(formatCancelHuman(resp.data));
        else console.error(resp.error?.message ?? 'cancel failed');
        process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
        return;
      }
      const resp = await handleOrders(args);
      if (json) console.log(JSON.stringify(resp));
      else if (resp.ok) console.log(formatOrdersHuman(resp.data));
      else console.error(resp.error?.message ?? 'orders failed');
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // Full account view. Only `status` had a block before, so this path was
    // unreachable from the CLI even once a wallet existed.
    if (resolved.canonical === 'portfolio') {
      const resp = await handlePortfolio(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatPortfolioHuman(resp.data, resp.meta?.warnings ?? []));
      } else {
        console.error(resp.error?.message ?? 'portfolio failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── analyze ───────────────────────────────────────────────────────
    if (resolved.canonical === 'analyze') {
      // Batch mode: 2+ positional tickers OR --tickers csv. Routes through
      // POST /kalshi/markets/edge in a single call (vs. N serial Octagon
      // round-trips). Use --refresh on a single ticker for the full deep
      // analysis pipeline.
      const csvTickers = args.tickers
        ? args.tickers.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const tickerList = [...args.positionalArgs, ...csvTickers];
      if (tickerList.length > 1) {
        const { handleAnalyzeBatch, formatAnalyzeBatchHuman } = await import('./analyze-batch.js');
        const resp = await handleAnalyzeBatch(tickerList);
        if (json) {
          console.log(JSON.stringify(resp));
        } else if (resp.ok) {
          console.log(formatAnalyzeBatchHuman(resp.data));
        } else {
          console.error(resp.error?.message ?? 'analyze (batch) failed');
        }
        process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
        return;
      }
      const ticker = args.positionalArgs[0];
      if (!ticker) {
        const errResp = wrapError('analyze', 'MISSING_TICKER', 'Usage: analyze <ticker> [--refresh] [--report]');
        if (json) {
          console.log(JSON.stringify(errResp));
          process.exit(ExitCode.USER_ERROR);
        } else {
          console.error('Usage: analyze <ticker> [--refresh] [--report]');
          process.exit(ExitCode.USER_ERROR);
        }
        return;
      }
      const refresh = args.refresh;
      const data = await handleAnalyze(ticker, refresh);
      if (json) {
        console.log(JSON.stringify(wrapSuccess('analyze', data)));
      } else {
        console.log(formatAnalyzeHuman(data));
        if (args.report && data.rawReport) {
          console.log('\n' + formatRawReport(data.rawReport, ticker));
        }
        await promptAnalyzeActions(data);
      }
      return;
    }

    // ─── similar (Octagon semantic search) ─────────────────────────────
    if (resolved.canonical === 'similar') {
      const resp = await handleSimilar(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatSimilarHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'similar failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── catalysts (upcoming market closes grouped by week) ────────────
    if (resolved.canonical === 'catalysts') {
      const resp = await handleCatalysts(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatCatalystsHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'catalysts failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── report (full Octagon markdown report) ─────────────────────────
    if (resolved.canonical === 'report') {
      const resp = await handleReport(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatReportHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'report failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── trust (Trader Trust scorecard) ────────────────────────────────
    if (resolved.canonical === 'trust') {
      const resp = await handleTrust(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatTrustHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'trust failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── events (Octagon events list / detail) ─────────────────────────
    if (resolved.canonical === 'events') {
      const resp = await handleEvents(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatEventsHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'events failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    if (resolved.canonical === 'wallet') {
      const resp = await handleWallet(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok) {
        console.log(formatWalletHuman(resp.data));
      } else {
        console.error(resp.error?.message ?? 'wallet failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── watch ─────────────────────────────────────────────────────────
    if (resolved.canonical === 'watch') {
      // Force index rebuild before watching if --refresh is set
      if (args.refresh) {
        await forceRefreshIndex();
      }
      // Per-ticker mode if a positional arg is given and no --theme
      const ticker = args.positionalArgs[0];
      if (ticker && !args.theme) {
        const { handleWatchTicker } = await import('./watch.js');
        await handleWatchTicker(ticker.toUpperCase(), args);
        return;
      }
      // Theme scan mode (existing behavior)
      await handleWatch(args);
      return;
    }

    // ─── backtest ──────────────────────────────────────────────────────
    if (resolved.canonical === 'backtest') {
      const resp = await handleBacktest(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (resp.ok && resp.data) {
        console.log(formatBacktestHuman(resp.data, {
          minEdge: args.minEdge ?? 0.005,
        }));
      } else {
        console.error(resp.error?.message ?? 'Backtest failed');
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // ─── help ──────────────────────────────────────────────────────────
    if (subcommand === 'help') {
      const topic = args.positionalArgs[0];
      const result = buildHelp('cli', topic);
      if ('error' in result) {
        const errResp = wrapError('help', 'UNKNOWN_TOPIC', result.error);
        if (json) {
          console.log(JSON.stringify(errResp));
          process.exit(ExitCode.USER_ERROR);
        } else {
          console.error(result.error);
          process.exit(ExitCode.USER_ERROR);
        }
        return;
      }
      if (json) {
        console.log(JSON.stringify(wrapSuccess('help', { text: result.text })));
      } else {
        console.log(result.text);
      }
      return;
    }

    // ─── Legacy commands (kept for backward compat) ────────────────────

    // Edge command
    if (subcommand === 'edge') {
      const resp = await handleEdge(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else {
        console.log(formatEdgeHuman(resp.data));
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // Config command
    if (subcommand === 'config') {
      const resp = await handleConfig(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else if (!resp.ok) {
        const errMsg = (resp as { error?: { message?: string } }).error?.message ?? 'Config error';
        console.error(errMsg);
      } else {
        console.log(formatConfigHuman(resp.data));
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // Clear cache command
    if (subcommand === 'clear-cache') {
      const { handleClearCache } = await import('./clear-cache.js');
      const result = handleClearCache();
      if (json) {
        console.log(JSON.stringify(wrapSuccess('clear-cache', result)));
      } else {
        console.log(result.message);
      }
      return;
    }

    // Alerts command
    if (subcommand === 'alerts') {
      const resp = await handleAlerts(args);
      if (json) {
        console.log(JSON.stringify(resp));
      } else {
        console.log(formatAlertsHuman(resp.data));
      }
      process.exit(resp.ok ? ExitCode.SUCCESS : ExitCode.USER_ERROR);
      return;
    }

    // Unknown command
    const resp = wrapError(subcommand, 'UNKNOWN_COMMAND', `Unknown command: ${subcommand}`);
    if (json) {
      console.log(JSON.stringify(resp));
      process.exit(ExitCode.USER_ERROR);
    } else {
      console.error(`Error: unknown command "${subcommand}"`);
      process.exit(ExitCode.USER_ERROR);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = exitCodeFromError(err);
    const errorCode = code === ExitCode.AUTH_ERROR
      ? 'AUTH_ERROR'
      : code === ExitCode.EXTERNAL_ERROR
        ? 'EXTERNAL_ERROR'
        : code === ExitCode.USER_ERROR
          ? 'USER_ERROR'
          : 'INTERNAL_ERROR';
    const resp = wrapError(subcommand, errorCode, message);
    trackEvent('error_occurred', { command: subcommand, error_code: errorCode });

    if (json) {
      console.log(JSON.stringify(resp));
      process.exit(code);
    } else {
      console.error(`Error running "${subcommand}": ${message}`);
      process.exit(code);
    }
  }
}
