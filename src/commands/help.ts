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

${p}search [theme|query]         Find EVENTS matching a theme or free text
${p}search <event-slug>          Drill into one event: list its markets
${p}search <theme>:<subtheme>    Narrow a theme, e.g. crypto:btc, sports:baseball
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

Results are events by default — markets live inside an event, so pass an event
slug to see them. Any market-level filter (--min-volume, --close-before,
--sort-by, --category, --series) searches markets instead, since the event
route does not support them.

Examples:
  ${p}search crypto                  events in the Crypto category
  ${p}search crypto:btc              narrowed to BTC
  ${p}search fed-decision-in-september-762
  ${p}search "bitcoin price" --min-volume 10000
  ${p}search edge --min-edge 30 --category crypto

Tip: ${p}similar <market-slug> walks the event → series → category tree to find related markets.`,

    wallet: `**${p}wallet** — Your Polymarket wallet

${p}wallet                       Show the current wallet (same as \`show\`)
${p}wallet import <private-key>  Import your polymarket.com wallet (enables trading)
${p}wallet import <address>      Read-only: balances and positions, no trading
${p}wallet address               Print the funding address only
${p}wallet show                  Addresses, wallet type, mode, key source

Flags:
  --force                           Replace an existing wallet

There is no ${p}wallet create. A wallet made here would be a fresh account with
no Polymarket history, and polymarket.com deposits only into the account it made
for you — so the way in is to import the key for the account you already have.

A Polymarket account has two addresses:
  Signing wallet   the keypair that signs orders. Holds nothing.
  Funding wallet   a contract it controls. Holds your pUSD. Deposit here.

Orders are signed messages, not transactions — Polymarket settles them — so
this CLI never sends anything on-chain and you never need POL for gas.

Reading a balance at the signing wallet always shows zero, so ${p}wallet show
prints both. Which contract is the funding wallet is not computable from the
key — Polymarket is asked once, at import, and the answer is saved. An address
you paste is taken as the FUNDING wallet, which is what your polymarket.com
profile shows.

Whatever the key controls, this CLI controls — so keep in that account only
what you intend to trade.

The key is written to ~/.polymarket-bot/wallet.json with owner-only (0600)
permissions, never to .env. No environment variable can supply a key or an
address — the saved wallet is the only one. To switch, import again with --force
or re-run the setup wizard; either resolves the account and saves it as a unit.
`,

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

${p}buy <market-slug> <shares> [price] [outcome]

  shares    Number of shares. Fractional is fine.
  price     Decimal USD in (0,1), e.g. 0.56. OMIT for a market order.
  outcome   yes | no, or an outcome name. Defaults to Yes.

Examples:
  ${p}buy bitcoin-above-100k-2026 10            Market order, 10 Yes shares
  ${p}buy bitcoin-above-100k-2026 10 0.56       Limit at $0.56, rests on the book
  ${p}buy bitcoin-above-100k-2026 10 0.56 no    Limit on the No side
  ${p}buy epl-ars-che-2026 25 Arsenal           Non-binary market, by outcome name

A market order fills now or not at all. A limit order rests until it fills,
expires, or you cancel it — see ${p}orders.

Every order shows the price and total cost and asks before it is sent. --yes
skips that prompt for scripting, and is the only way to skip it.

The circuit breaker (daily loss limit, max drawdown) blocks orders outright;
--force overrides it deliberately.`,

    sell: `**${p}sell** — Sell shares you hold

${p}sell <market-slug> <shares|max> [price] [outcome]

Same shape as ${p}buy. Omit the price to sell at the best bid.

Examples:
  ${p}sell bitcoin-above-100k-2026 10           Market sell, 10 Yes shares
  ${p}sell bitcoin-above-100k-2026 max          The whole position
  ${p}sell bitcoin-above-100k-2026 10 0.72      Limit at $0.72

Use \`max\` more often than you would expect. A market buy spends a dollar
amount rather than buying a share count, so it leaves an unround holding behind
— $1.03 of a $0.047 outcome is 21.914894 shares, and asking to sell 22 is
refused for a balance you do not have.

The size is checked against what the venue says you hold, not against this
CLI's own records, so positions opened elsewhere count too. If that balance
cannot be read the order still goes through, with a warning.`,

    orders: `**${p}orders** — Resting orders on the CLOB

${p}orders                       Everything still working on the book
${p}orders <order>               One order in full, including its complete id
${p}orders cancel <order>        Cancel one
${p}orders cancel <o> <o> <o>    Cancel several at once
${p}orders cancel --all          Cancel every resting order

An order id is 66 characters, which no table can show, so the list prints a
short prefix. That prefix is what you pass back — to ${p}orders for the detail
view, or to ${p}orders cancel. A prefix that matches more than one order is
refused rather than guessed at, and ${p}orders <order> prints the full id when
you want to copy it.

A resting order is one the venue accepted but has not matched. It is not a
position until it fills, so it will not appear in ${p}portfolio.

Cancelling cannot lose money — it only removes orders from the book — so none of
these ask for confirmation. Ids that had already filled or expired are reported
rather than counted as cancelled.`,

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

    trust: `**${p}trust** — Octagon Trust Index for an event

${p}trust <event-slug>                       Trust Index (overall score + profile)
${p}trust <event-slug> --verbose             …plus per-contract market quality
${p}trust <event-slug> --market <market-slug>     Single-market detail card
${p}trust <event-slug> --market <market-slug> --verbose
                                            Include raw evidence + confidence

The Trust Index (0-100, higher = better) combines two axes:

  Integrity      Market integrity, info fairness, resolution quality
  Trade quality  Cost to trade, including whether a $1,000 order can fill

It is a weighted blend with hard caps: a critically weak safety pillar, or a
severe trading anomaly, caps the total regardless of the rest. The trust
profile breaks out the three integrity pillars and the event's liquidity,
move quality and rule clarity.

The --market detail card shows four per-market scores (each 0-100, higher =
better): market_quality (composite), liquidity, move_quality and
resolution_clarity.

Flags:
  --market <slug>     Drill into one market in the event
  --verbose           Add per-contract market quality to the Trust Index; with
                      --market, show evidence (raw metrics) and confidence
  --json              JSON envelope output

Notes:
  - When trader_trust_json is null (older reports), prints "no trust scorecard for
    this event yet" — not an error.
  - A score can be unscored (not applicable, or insufficient data); it renders
    as "—", never as 0.
  - Detail cards show fair value and bid/ask in cents.`,

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
  orders cancel <order>               Cancel a resting order

Analysis:
  backtest                      Model accuracy scorecard + live edge scanner
  backtest --resolved           Resolved markets scorecard only
  backtest --unresolved         Live edge scanner only

Account:
  wallet                        Create, import, or inspect your wallet
  buy <slug> <shares> [price]   Buy shares (omit price for a market order)
  sell <slug> <shares> [price]  Sell shares you hold
  orders                        Your resting orders on the CLOB
  orders <order>                One order in full
  orders cancel <order>         Cancel a resting order (--all for every one)
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
  /orders cancel <order>               Cancel a resting order

Account:
  /wallet                        Create, import, or inspect your wallet
  /buy <slug> <shares> [price]   Buy shares (omit price for a market order)
  /sell <slug> <shares> [price]  Sell shares you hold
  /orders                        Your resting orders on the CLOB
  /orders <order>                One order in full
  /orders cancel <order>         Cancel a resting order (--all for every one)
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
/** The price half of `validateTradeArgs`, for sizes that are not a number. */
export function validatePriceOnly(
  priceStr?: string,
): { price: number | undefined } | { error: string } {
  if (priceStr === undefined) return { price: undefined };
  const parsed = Number(priceStr);
  if (!/^\d*\.?\d+$/.test(priceStr) || !Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return { error: `Invalid price: ${priceStr}. Price is decimal USDC between 0 and 1, e.g. 0.56 for 56c.` };
  }
  return { price: parsed };
}

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
