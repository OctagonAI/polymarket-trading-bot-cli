// ─── Shared help content for both TUI slash commands and CLI batch mode ─────
import { isDeferredCommand, COMMAND_FEATURE, octagonSupports, octagonUnavailableMessage } from '../scan/octagon-capabilities.js';
import { THEMES } from '../scan/theme-registry.js';
import { isCommandAvailable, commandUnavailableReason } from '../tools/polymarket/polymarket-trade.js';

/** Context determines prefix style: slash commands use "/", CLI uses "polymarket" */
type HelpContext = 'slash' | 'cli';

function prefix(ctx: HelpContext): string {
  return ctx === 'slash' ? '/' : 'polymarket ';
}

function buildTopics(ctx: HelpContext): Record<string, string> {
  const p = prefix(ctx);
  return {
    search: `**${p}search** — Discovery (Octagon-powered when OCTAGON_API_KEY is set)

${p}search [theme|ticker|query]  Full-text market search (server-side when key is set, else local index)
${p}search themes                List all available themes and subcategories

Themes (a bare theme name returns that whole category):
  ${THEMES.map((t) => t.id).join(', ')}, top50
${p}search edge                  Edge ranking from latest Octagon run (server-side) or local cache
${p}search edge --min-edge 30    Markets with ≥30pp edge
${p}search edge --limit 50       Top 50 results
${p}search edge --category crypto Filter by category
${p}search edge --sort-by total_volume  Sort: edge_pp | expected_return | total_volume | model_probability

Search flags (server-side path):
  --category <name>     Filter by category
  --series <ticker>     Filter to a series
  --min-volume <n>      Floor on 24h volume
  --close-before <iso>  Only markets closing before this timestamp
  --days-to-close <n>   Shortcut: only markets closing in the next N days
  --limit <n>           Page size (default 30)
  --sort-by <key>       volume_24h | close_time | last_price (server-side sort)
  --aggregate-by series Roll up results by series (calls series rollup)
  --active-only         Drop non-active markets (defensive; the live universe is active by default)

Examples:
  ${p}search crypto
  ${p}search "bitcoin price" --min-volume 10000
  ${p}search edge --min-edge 30 --category crypto

Tip: ${p}similar <market-slug> walks the event → series → category tree to find related markets.`,

    wallet: `**${p}wallet** — Your Polymarket wallet

${p}wallet                       Show the current wallet (same as \`show\`)
${p}wallet create                Generate a new dedicated wallet
${p}wallet import <private-key>  Bring an existing wallet (enables trading)
${p}wallet import <address>      Read-only: balances and positions, no trading
${p}wallet address               Print the funding address only
${p}wallet show                  Addresses, mode, key source, on-chain proxy status

Flags:
  --force                           Replace an existing wallet
  --proxy <address>                 Pin the funding address instead of deriving it

A Polymarket account has two addresses:
  Signing wallet   the keypair that signs. Pays gas in POL.
  Funding wallet   a contract derived from it. Holds your pUSD. Deposit here.

Reading a balance at the signing wallet always shows zero, so ${p}wallet show
prints both. An address you paste is treated as the FUNDING wallet, which is
what polymarket.com shows you as your deposit address.

Use a dedicated wallet. The private key is stored on this machine and whatever
it controls, this CLI controls — so fund it with what you intend to trade, not
with everything you own.

The key is written to ~/.polymarket-bot/wallet.json with owner-only (0600)
permissions, never to .env. Override it for one session with
POLYMARKET_PRIVATE_KEY, which takes precedence over the saved file.`,

    portfolio: `**${p}portfolio** — Account state

${p}portfolio                    Full overview: positions, P&L, risk snapshot
${p}portfolio positions          Open positions with P&L
${p}portfolio balance            Account balance
${p}portfolio status             Exchange status${ctx === 'cli' ? ' and setup verification' : ''}
${ctx === 'cli' ? `
Flags:
  --performance                     Include win rate, Sharpe, Brier scores
  --json                            JSON output` : ''}`,

    analyze: `**${p}analyze** — Deep market analysis

${p}analyze <market-slug>                  Full analysis: edge, drivers, catalysts, Kelly sizing
${p}analyze <market-slug> ${ctx === 'cli' ? '--' : ''}refresh        Force fresh Octagon report

Batch mode (one Octagon round-trip instead of N):
${p}analyze slug-a slug-b slug-c                 Edge readout across 2-100 tickers
${p}analyze --tickers slug-a,slug-b,slug-c       Same, comma-separated
${p}analyze slug-a slug-b slug-c --json          For pipelines / scripting

The batch mode hits POST /markets/edge in one call and returns
model_probability, market_probability, edge_pp, expected_return per ticker.
Use single-ticker mode when you need the full deep-analysis pipeline
(drivers, catalysts, Kelly sizing, risk gate).

Position sizing needs a bankroll. With a wallet configured it uses your on-chain
pUSD balance; ${p}config risk.bankroll_usdc <amount> caps it lower. With neither,
analyze reports edge and catalysts but skips sizing.${ctx === 'cli' ? `

Legacy aliases (still work):
  ${p}edge [--ticker X]                    Edge history / snapshots (default: last 24h)
  ${p}edge --since <date>                  Edges since date (e.g. 2026-03-01)` : ''}`,

    watch: `**${p}watch** — Live monitoring

Modes:
  ${p}watch <market-slug>          Per-market price/orderbook feed (5s default)
  ${p}watch --theme <theme>        Continuous theme scan${ctx === 'cli' ? ' (default: every 60m)' : ' (press Esc to stop)'}
${ctx === 'cli' ? `
Flags:
  --interval <minutes>              Scan interval for theme mode (min 15)
  --live                            Force 15m interval
  --json                            NDJSON output (one line per tick/cycle)
  --dry-run                         Scan without persisting edges

Press Ctrl+C to stop.` : `
Per-ticker mode shows live price, bid/ask, spread, volume, and top-5 orderbook.
Theme mode runs recurring Octagon scans and displays an edge table.`}`,

    buy: `**${p}buy** — Buy shares

${p}buy <market-slug> <shares> [price] [yes|no]${ctx === 'slash' ? '   Buy shares (price 0-1)' : ''}

Example${ctx === 'cli' ? 's' : ''}:
  ${p}buy bitcoin-above-100k-2026 10 ${ctx === 'cli' ? '          Buy at best ask (10 YES shares)' : '0.56'}
  ${p}buy bitcoin-above-100k-2026 10 ${ctx === 'cli' ? '0.56      Limit order at $0.56/share' : '0.56 no  Buy NO shares'}
${ctx === 'cli' ? `  ${p}buy bitcoin-above-100k-2026 10 0.56 no  Limit order for NO shares at $0.56` : ''}
Side defaults to YES if omitted.`,

    sell: `**${p}sell** — Sell shares

${p}sell <market-slug> <shares> [price] [yes|no]${ctx === 'slash' ? '  Sell shares (price 0-1)' : ''}

Example${ctx === 'cli' ? 's' : ''}:
  ${p}sell bitcoin-above-100k-2026 10 ${ctx === 'cli' ? '         Sell at best ask (10 YES shares)' : '0.72'}
  ${p}sell bitcoin-above-100k-2026 10 ${ctx === 'cli' ? '0.72      Limit order at $0.72/share' : '0.72 no  Sell NO shares'}
${ctx === 'cli' ? `  ${p}sell bitcoin-above-100k-2026 10 0.72 no  Limit order for NO shares at $0.72` : ''}
Side defaults to YES if omitted.`,

    cancel: `**${p}cancel** — Cancel a resting order

${p}cancel <order_id>`,

    backtest: `**${p}backtest** — Model accuracy scorecard & edge scanner

${p}backtest                              15-day lookback, both sections (default)
${p}backtest --days 30                    30-day lookback
${p}backtest --max-age 14                 Reject predictions older than 14 days (default = --days)
${p}backtest --resolved                   Resolved markets only
${p}backtest --unresolved                 Unresolved markets only
${p}backtest --category crypto            Filter by category
${p}backtest --min-edge 10                Stricter edge threshold in pp (default 0.5pp)
${p}backtest --min-volume 10              Per-contract volume gate (default 1)
${p}backtest --min-price 5 --max-price 95 Tradeable price band 0-100 (defaults: 5 / 95)
${p}backtest --universe api              Systematic Octagon-API universe (default; reproducible across machines)
${p}backtest --universe local            Legacy local octagon_reports universe (offline, NON-SYSTEMATIC)
${p}backtest --fees taker                Apply Taker fee (0.07·p·(1−p) per entry); default 'none' = gross
${p}backtest --fees maker                Maker execution (free entry)
${p}backtest --export results.csv         Per-market detail CSV
${p}backtest --json                       Machine-readable output

Looks back N days, compares what the model said then to where the market is now.
Resolved markets: scored against settlement (0 or 100).
Unresolved markets: mark-to-market vs current market price.
Per-contract entry: mp/kp come from the per-contract outcome_probabilities on the
Octagon snapshot (no event-level fallback). Volume gate requires per-contract
volume from the snapshot; signals without it are dropped (the legacy fallback
to lifetime volume was a look-ahead and has been removed).
ROI is capital-weighted: sum(pnl) / sum(capital) across edge signals, where capital
is kp/100 for YES edges and (100-kp)/100 for NO edges (matches Supabase methodology).`,

    'clear-cache': `**${ctx === 'cli' ? '' : 'polymarket '}clear-cache** — Delete local cache

${ctx === 'cli' ? `${p}` : 'polymarket '}clear-cache                Delete the local SQLite database (~/.polymarket-bot/polymarket-bot.db)
                               A fresh database will be created on next command.

Use this when the local cache is corrupted or you want to start fresh.${ctx !== 'cli' ? '\nRun from terminal: polymarket clear-cache' : ''}`,

    init: `**${p}init** — Re-run setup wizard

${p}init                       Launch the TUI with the setup wizard open
                               Use this to configure or reconfigure API keys and preferences.`,

    help: `**${p}help** — Show help

${p}help                       Show all commands
${p}help <command>             Show detailed help for a command`,

    scripting: `**Scripting & Parallel Use** — for agents, pipelines, and parallel invocations

The \`bunx polymarket-trading-bot-cli@latest …\` form is convenient for one-off use
but has two gotchas under scripting:

  1. Bun's install chatter ("Resolving dependencies", "Saved lockfile") leaks
     into stdout before our CLI runs, corrupting JSON pipelines.
  2. Parallel \`bunx\` invocations race on the install cache and fail with
     "Failed to link …: EEXIST" / "could not determine executable".
     See oven-sh/bun#12917 for upstream status.

**Recommended for scripts and agents:**

  bun add -g polymarket-trading-bot-cli           # install once; emits no chatter on subsequent runs
  parallel -j 30 'polymarket analyze {} --json' ::: TICKER1 TICKER2 …

**If you must use bunx:**

  bunx --silent polymarket-trading-bot-cli@latest analyze bitcoin-above-100k-2026 --json
                ^^^^^^^^ suppresses install chatter; keeps our stdout clean

For parallel bunx, pre-warm the cache serially before fanning out:

  bunx --silent polymarket-trading-bot-cli@latest --version        # one-shot, warms cache
  parallel -j 30 'bunx --silent polymarket-trading-bot-cli@latest analyze {} --json' ::: …

See README → Scripting & Parallel Use for the full picture.`,

    similar: `**${p}similar** — Related markets (Octagon-powered)

${p}similar <market-slug>             Markets related to this one
${p}similar -q "free-text query"      Markets matching a keyword query
${p}similar <market-slug> --top-k 25  Return the top 25
${p}similar -q "..." --category crypto --min-volume 10000 --close-before 2026-08-19T00:00:00Z

Flags:
  --top-k <n>             Number of results (default 25, max 100)
  --category <name>       Restrict to a category
  --min-volume <n>        Floor on 24h volume
  --close-before <iso>    Only markets closing before this timestamp
  --json                  JSON output

How results are ordered:
  <market-slug>  Same event first, then same series, then same category —
                 each tier by 24h volume. Structural relatedness, not meaning.
  -q "text"      Keyword relevance, then 24h volume.

This is not semantic search: it will not match "Bitcoin pierce six figures" to
"BTC over $100k". Use ${p}search for keyword lookups across the whole universe.

The API returns a \`distance\` field in --json output. Ignore it — it is
row_number()/1000, so it only restates row order and is not comparable
between responses.`,




    report: `**${p}report** — Print the full Octagon markdown report for an event

${p}report <event-slug>           Cached report body (most recent)
${p}report <market_ticker>          Resolves to the parent event automatically
${p}report <series_ticker>          Resolves to the latest event in the series
${p}report <polymarket_url>             Accepts a full polymarket.com URL too
${p}report <event-slug> --refresh       Force a fresh pull from Octagon (costs 3 credits)

The full deep-research markdown body — same content the OctagonAI web app shows.
Lookup is more lenient than \`analyze\`: tries Octagon's event endpoint first
before falling back to the resolver chain, so series tickers and
events without open markets still work.

Flags:
  --refresh    Force a fresh report instead of returning the cached one${ctx === 'cli' ? `
  --json       JSON envelope output (rawReport carries the markdown)` : ''}

When a report body is found, the output footer shows: source (cache | fresh),
local cache fetch timestamp + age, and the upstream Octagon
analysis_last_updated when available — so you can decide whether to --refresh.
Error paths (missing ticker, event not found, no report body yet) print just
the error message instead.`,

    trust: `**${p}trust** — Trader Trust scorecard (market-integrity metrics)

${p}trust <event-slug>                       Table across all markets in the event
${p}trust <event-slug> --market <market-slug>     Single-market detail card
${p}trust <event-slug> --market <market-slug> --verbose
                                            Include raw evidence + confidence/freshness

Six per-market scores (each 0-100), produced by Octagon's deterministic
Trader Trust calculation:

  trader_trust       Overall composite                      (higher = better)
  liquidity_quality  Depth/spread/fill behavior             (higher = better)
  move_quality       Price-move plausibility                (higher = better)
  resolution_risk    Resolution clarity (higher = clearer)  (higher = better)
  market_avoid       Avoidance signal                       (higher = WORSE)
  quote_risk         Quote-side risk                        (higher = WORSE)

Flags:
  --market <slug>     Drill into one market in the event
  --verbose           Show evidence (raw metrics), confidence, data freshness
  --json              JSON envelope output

Notes:
  - When trader_trust_json is null (older reports), prints "no trust scorecard for
    this event yet" — not an error.
  - Higher-is-better vs. higher-is-worse semantics differ per score; tables and
    detail views color and annotate accordingly.
  - "(as of report time)" is shown for scores whose data_freshness is
    point_in_time (e.g. quote_risk, liquidity_quality on snapshot reports).`,

    events: `**${p}events** — Octagon event rollups (event ↔ outcome ladder)

${p}events                              List events sorted by total_volume
${p}events --category Politics          Filter by series_category
${p}events --min-volume 10000           Volume floor
${p}events --limit 25                   Page size (default 50)
${p}events fed-chair-nominee-2029             Drill into one event: outcome probabilities + per-contract edge

Flags:
  --category <name>     Filter by series_category (case-insensitive substring)
  --min-volume <n>      Floor on total_volume
  --limit <n>           Page size (default 50)
  --json                JSON envelope output

Each event is a multi-market question (e.g. "Who will Trump nominate as Fed Chair?")
with one binary sub-market per outcome (Kevin Warsh, Judy Shelton, ...).
Octagon supplies a model_probability per outcome so you can rank contracts by edge.`,


    catalysts: `**${p}catalysts** — Upcoming market closes grouped by week

${p}catalysts upcoming                       Next 30 days
${p}catalysts upcoming --days 7              Next week
${p}catalysts upcoming --days 14 --min-volume 5000 --category Politics
${p}catalysts upcoming --limit 10            Up to 10 markets per week shown

Flags:
  --days <n>           Lookback window (default 30)
  --min-volume <n>     Floor on 24h volume
  --category <name>    Filter by category
  --limit <n>          Top-N markets per week (default 8)
  --json               JSON output

Use for catalyst-calendar planning: see which weeks have major
resolutions cluster up so you can position before catalyst risk.`,

    themes: `**${p}themes** — Editorial narrative registry (curated theme buckets)

${p}themes                                List registered editorial themes
${p}themes import <path>                  Import themes from a JSON file
${p}                                      (no Polymarket seed file ships yet)
${p}themes export <path>                  Export current registry
${p}themes show "Iran Escalation"         Drill into one theme
${p}themes create "My Theme" --tickers slug-a,slug-b --label "..." [--min-volume N]
${p}themes delete "My Theme"
${p}themes add-series "My Theme" bitcoin-daily,ethereum-daily
${p}themes remove-series "My Theme" bitcoin-daily
${p}themes set-search-volume "My Theme" 100000
${p}themes report                         Dashboard: 25-theme grid with SEO + liquidity
${p}themes audit                          Flag dead themes (high SEO + zero volume)
${p}themes overlap                        Cross-theme dedupe report

Editorial themes are narrative buckets you curate (e.g. "AI Race Milestones",
"Iran Escalation") — distinct from Octagon's ML clusters. Each theme maps to a
list of series and an optional monthly search-volume estimate.

Flags:
  --label <desc>        Set description on create
  --min-volume <n>      Set search_volume on create (poorly named — improve later)
  --tickers <csv>       Comma-separated series on create
  --json                JSON output

Legacy: ${p}search themes still lists category labels (the pre-registry view).`,

  };
}

/**
 * Drop command lines for anything currently gated (Octagon-backed commands the
 * Polymarket client cannot serve, plus order placement), then drop any section
 * heading left with nothing under it. Keeps the overview honest without having
 * to hand-maintain a second copy of the command list.
 */
function stripGatedLines(text: string): string {
  const gated = (name: string) => isDeferredCommand(name) || !isCommandAvailable(name);

  const kept = text.split('\n').filter((line) => {
    const m = line.match(/^\s{2}\/?([a-z-]+)/);
    return !(m && gated(m[1]!));
  });

  // Collapse headings that no longer have any commands beneath them.
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    const isHeading = /^[A-Z][A-Za-z &/]*:$/.test(line.trim());
    if (isHeading) {
      const next = kept.slice(i + 1).find((l) => l.trim() !== '');
      if (!next || /^[A-Z][A-Za-z &/]*:$/.test(next.trim())) continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function buildOverview(ctx: HelpContext): string {
  const p = prefix(ctx);
  if (ctx === 'cli') {
    return `**Polymarket Trading Bot CLI — CLI Commands**

Quick start:
  polymarket search crypto          Find markets by keyword or theme
  polymarket analyze <market-slug>  Deep analysis + trade recommendation
  polymarket watch --theme crypto   Continuous scan across a theme

Discovery:
  search [theme|ticker|query]   Find markets (Octagon when key set, else local)
  search --sort-by volume_24h   Top-N by liquidity
  search --aggregate-by series  Roll up results to series level
  search themes                 (Legacy) Category labels
  search edge [--min-edge N]    Edge ranking (Octagon when key set, else local)
  similar <market-slug>         Related markets (same event → series → category)
  similar -q "free text"        Keyword search ranked by relevance
  clusters [--label X]          Browse thematic clusters
  clusters <id>                 List markets in a cluster
  clusters --behavioral         Behavioral clusters (30-day return vectors)
  clusters --ranked             Rank clusters by historical basket return
  peers <ticker>                Find markets in the same cluster
  events                        Octagon events (event ↔ outcome ladder)
  events <event-slug>         Drill into one event's outcome probabilities
  series                        Series rollup with 24h vol, market count
  series <SERIES>               Sub-markets in one series
  series candles <SERIES>       Series NAV (basket of top sub-markets)
  catalysts upcoming --days 30  Markets closing soon, grouped by week
  trust <event-slug>          Trader Trust scorecard (table across markets)
  trust <event-slug> --market <slug>  Single-market trust detail card
  report <event-slug>         Full Octagon markdown report (use --refresh for fresh pull)
  watch <market-slug>           Live price/orderbook feed
  watch --theme <theme>         Continuous theme scan (Ctrl+C to stop)
  watch --refresh               Force index rebuild before watching

Editorial themes (narrative registry):
  themes                        List registered editorial themes
  themes import <path>          Seed from a JSON file (no Polymarket seed ships yet)
  themes show <name>            Drill into one theme
  themes report                 25-theme dashboard with SEO + liquidity
  themes audit                  Flag dead themes (high SEO + zero volume)
  themes overlap                Cross-theme dedupe report
  themes create/delete/add-series/remove-series/set-search-volume/export

Portfolio construction:
  correlate <t1> <t2> [...]     Pairwise Pearson correlation matrix
  basket build [filters] -n N   Diversified basket with cluster + correlation caps
  basket backtest --tickers ... NAV summary with Sharpe, max DD, win rate
  basket size --bankroll $ --probs ...   Fractional Kelly sizing for picked legs
  basket candles --tickers ...  OHLC bars for a weighted basket NAV

Analysis & Trading:
  analyze <market-slug>         Full report: edge, drivers, Kelly sizing
  analyze <market-slug> --refresh  Force fresh Octagon report
  buy <market-slug> <shares> [price] [yes|no]   Buy shares (price 0-1)
  sell <market-slug> <shares> [price] [yes|no]  Sell shares
  cancel <order_id>                   Cancel a resting order

Analysis:
  backtest                      Model accuracy scorecard + live edge scanner
  backtest --resolved           Resolved markets scorecard only
  backtest --unresolved         Live edge scanner only

Account:
  wallet                        Create, import, or inspect your wallet
  portfolio                     Overview: positions, P&L, risk snapshot
  portfolio positions           Open positions
  portfolio balance             Account balance

System:
  status                        Check setup: connectivity, API keys
  init                          Launch with setup wizard (configure API keys)
  clear-cache                   Delete local SQLite cache and start fresh
  setup                         Re-run setup wizard
  help [command]                Show help for a command

Flags: --json, --refresh, --performance, --dry-run, --verbose
Backtest flags: --days, --max-age, --resolved, --unresolved, --category, --min-edge,
                --min-volume, --min-price, --max-price, --export,
                --universe api|local (default api), --fees none|taker|maker (default none)
Run "polymarket help <command>" for detailed usage.`;
  }

  return `**Polymarket Trading Bot CLI — Commands**

Quick start:
  /search crypto          Find markets by keyword or theme
  /analyze <ticker>       Deep analysis + trade recommendation
  /watch --theme crypto   Continuous scan across a theme

Discovery:
  /search [theme|ticker|query]   Find markets (Octagon when key set, else local)
  /search --sort-by volume_24h   Top-N by liquidity
  /search --aggregate-by series  Roll up results to series level
  /search themes                 (Legacy) Category labels
  /search edge [--min-edge N]    Edge ranking (Octagon when key set, else local)
  /similar <market-slug>         Related markets (same event → series → category)
  /similar -q "free text"        Keyword search ranked by relevance
  /clusters [--label X]          Browse thematic clusters
  /clusters <id>                 List markets in a cluster
  /clusters --behavioral         Behavioral clusters (30-day return vectors)
  /clusters --ranked             Rank clusters by historical basket return
  /peers <ticker>                Find markets in the same cluster
  /events                        Octagon events (event ↔ outcome ladder)
  /events <event-slug>         Drill into one event's outcome probabilities
  /series                        Series rollup with 24h vol, market count
  /series <SERIES>               Sub-markets in one series
  /series candles <SERIES>       Series NAV (basket of top sub-markets)
  /catalysts upcoming --days 30  Markets closing soon, grouped by week
  /trust <event-slug>          Trader Trust scorecard (table across markets)
  /trust <event-slug> --market <slug>  Single-market trust detail card
  /report <event-slug>         Full Octagon markdown report (use --refresh for fresh pull)
  /watch <ticker>                Live price/orderbook feed
  /watch --theme <theme>         Continuous theme scan (Esc to stop)
  /watch --refresh               Force index rebuild before watching

Editorial themes (narrative registry):
  /themes                        List registered editorial themes
  /themes import <path>          Seed from a JSON file (no Polymarket seed ships yet)
  /themes show <name>            Drill into one theme
  /themes report                 25-theme dashboard with SEO + liquidity
  /themes audit                  Flag dead themes (high SEO + zero volume)
  /themes overlap                Cross-theme dedupe report
  /themes create/delete/add-series/remove-series/set-search-volume/export

Portfolio construction:
  /correlate <t1> <t2> [...]     Pairwise Pearson correlation matrix
  /basket build [filters] -n N   Diversified basket with cluster + correlation caps
  /basket backtest --tickers ... NAV summary with Sharpe, max DD, win rate
  /basket size --bankroll $ --probs ...   Fractional Kelly sizing for picked legs
  /basket candles --tickers ...  OHLC bars for a weighted basket NAV

Analysis:
  /backtest                      Model accuracy scorecard + live edge scanner
  /analyze <ticker>              Full report: edge, drivers, Kelly sizing
  /analyze <ticker> refresh      Force fresh Octagon report
  /buy <ticker> <n> [price] [yes|no]   Buy contracts (price 0-1)
  /sell <ticker> <n> [price] [yes|no]  Sell contracts
  /review                              Review positions for close signals
  /cancel <order_id>                   Cancel a resting order

Account:
  /wallet                        Create, import, or inspect your wallet
  /portfolio                     Overview: positions, P&L, risk snapshot
  /portfolio positions           Open positions
  /portfolio balance             Account balance

System:
  /status                        Check setup: connectivity, API keys
  /model                         Change LLM model/provider
  /setup                         Re-run setup wizard
  init                           Launch with setup wizard (run: polymarket init)
  clear-cache                    Delete local cache (run: polymarket clear-cache)
  /help [command]                Show help for a command
  /quit                          Quit

Tips:
  Type natural language — e.g. "analyze world-cup-winner", "show my portfolio"
  Press Esc to cancel a running query`;
}

export function buildHelp(ctx: HelpContext, topic?: string): { text: string } | { error: string } {
  const topics = buildTopics(ctx);

  // Gated commands are answered before the topics map, and return only the
  // reason they cannot run. Their reference docs were deleted rather than shown
  // "for when it lands": that syntax belongs to a venue this tool does not
  // trade, and a Polymarket user should never be handed identifiers that cannot
  // resolve here. Restore them, rewritten for Polymarket, if the commands return.
  if (topic && isDeferredCommand(topic) && !octagonSupports(COMMAND_FEATURE[topic]!)) {
    return { text: octagonUnavailableMessage(COMMAND_FEATURE[topic]!, topic) };
  }
  const unavailable = topic ? commandUnavailableReason(topic) : null;
  if (topic && unavailable) {
    const body = topics[topic];
    return { text: body ? `${unavailable}\n\nReference:\n\n${body}` : unavailable };
  }

  if (topic && topics[topic]) {
    return { text: topics[topic] };
  }

  if (topic) {
    return { error: `Unknown help topic: "${topic}". Available: ${Object.keys(topics).join(', ')}` };
  }

  return { text: stripGatedLines(buildOverview(ctx)) };
}

/**
 * Shared trade argument validation for both dispatch and slash handlers.
 *
 * Both arguments are Polymarket-shaped, which differs from Kalshi on each:
 *
 *  - **Size is fractional.** Outcome tokens divide, and Kelly sizing already
 *    rounds to 2dp (`src/risk/kelly.ts`), so an integer-only check would reject
 *    the size the CLI itself just recommended.
 *  - **Price is a decimal in (0, 1)**, not integer cents — 0.56 means $0.56 per
 *    share, or a 56% implied probability. The bounds are exclusive because 0 and
 *    1 are the resolved outcomes, not tradeable prices.
 *
 * Tick-size and venue-minimum checks are deliberately not here: both are
 * per-market (`PolymarketMarket.tick_size` / `min_order_size`) and belong to the
 * order path, which can name the actual limit.
 */
export function validateTradeArgs(
  countStr: string,
  priceStr?: string,
): { count: number; price: number | undefined } | { error: string } {
  const count = Number(countStr);
  // Reject '', whitespace, '1e3' and 'Infinity' — Number() accepts all of them.
  if (!/^\d*\.?\d+$/.test(countStr) || !Number.isFinite(count) || count <= 0) {
    return { error: `Invalid size: ${countStr}. Size must be a positive number of shares, e.g. 25 or 12.5.` };
  }

  let price: number | undefined;
  if (priceStr !== undefined) {
    const parsed = Number(priceStr);
    if (!/^\d*\.?\d+$/.test(priceStr) || !Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      return {
        error: `Invalid price: ${priceStr}. Price is decimal USDC between 0 and 1, e.g. 0.56 for 56c.`,
      };
    }
    price = parsed;
  }

  return { count, price };
}
