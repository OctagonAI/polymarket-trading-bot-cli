# Polymarket Trading Bot CLI

AI-powered Polymarket research CLI that finds edge across prediction markets.

> **Research works with no credentials.** Market data, search, analysis and watch
> run natively against Polymarket (Gamma / CLOB / Data APIs). Octagon powers the
> research commands — `search`, `search edge`, `similar`, `events`, `trust`,
> `report`.
>
> **Trading needs a wallet.** Create an account on [polymarket.com](https://polymarket.com),
> fund it there, then `polymarket wallet import <private-key>`. Accounts made on
> the site arrive already approved for trading. Then `buy`, `sell`, `orders`,
> `cancel` and `portfolio` all work. Run `status` to check your setup.

Runs deep fundamental research on every market — independent probability estimates, ranked price drivers, catalyst calendars — then computes edge as the spread between model price and the live order book. Signals are sized using half-Kelly and filtered through a 5-gate risk engine before a dollar is risked.

Integrates with the [Octagon Research API](https://app.octagonai.co) for AI-generated probability estimates that power the edge detection engine.

![Polymarket Trading Bot CLI](assets/screenshot.png)

## Prerequisites

- **[Bun](https://bun.com/) ≥ 1.1** (required — the bot uses `bun:sqlite` and runs `.tsx` directly; Node.js won't work)
  ```bash
  curl -fsSL https://bun.com/install | bash
  ```
- A **Polymarket** account (a Polygon wallet with USDC) — required for trading only; market data and research work without one
- One **LLM provider key** (OpenAI / Anthropic / Google / xAI / OpenRouter / Ollama). The setup wizard collects these on first run.
- Optional: an **[Octagon](https://app.octagonai.co)** key for AI edge analysis, and a **Tavily** key for web research.

## Quick Start

```bash
bunx polymarket-trading-bot-cli@latest
```

That's it — no clone, no install. The setup wizard runs automatically on first launch and walks you through API keys.

Prefer a global install? `bun add -g polymarket-trading-bot-cli` then run `polymarket`.

> **Scripting and agent use** — for parallel invocations, `--json` consumers, or anything that pipes our output: **install globally and use the `polymarket` binary**, not `bunx`. See [Scripting & Parallel Use](#scripting--parallel-use) below for the gory details.

Or work from a clone:

```bash
git clone https://github.com/OctagonAI/polymarket-trading-bot-cli.git
cd polymarket-trading-bot-cli
bun install
bun start
```

### Where things live

- **Config, cache, SQLite DB:** `~/.polymarket-bot/`
- **API keys (`.env`):** `~/.polymarket-bot/.env` — written by the setup wizard. A `.env` in the current directory takes precedence (handy for dev).
- **First run** with no keys configured triggers the setup wizard automatically.

### Updating

Using `@latest` in the `bunx` command always pulls the newest published version — so `bunx polymarket-trading-bot-cli@latest` is the zero-friction path.

If you ran `bunx polymarket-trading-bot-cli` without `@latest`, Bun may serve a cached copy. Force a refresh:

```bash
bunx polymarket-trading-bot-cli@latest   # pin latest for this invocation
bun pm cache rm                      # or clear Bun's install cache
```

If you installed globally with `bun add -g polymarket-trading-bot-cli`:

```bash
bun update -g polymarket-trading-bot-cli         # update in place
bun add -g polymarket-trading-bot-cli@latest     # or reinstall pinned to latest
```

Check your installed version with `polymarket --version` (or `bun pm ls -g | grep polymarket`).

## Example Session

```text
$ bunx polymarket-trading-bot-cli@latest

Welcome to Polymarket Trading Bot CLI
Type help for commands, or just ask a question.

> search crypto

  Slug                              Title                          Last    Volume
  bitcoin-above-95k-by-april-30     Bitcoin above $95k by Apr 30   $0.58   12,841
  bitcoin-above-100k-by-april-30    Bitcoin above $100k by Apr 30  $0.31    8,203
  ethereum-above-2k-by-april-30     Ethereum above $2k by Apr 30   $0.72    5,419

3 markets found

> analyze bitcoin-above-95k-by-april-30

  Octagon Research Report — bitcoin-above-95k-by-april-30
  ───────────────────────────────────────────────────────
  Model Probability   72%
  Market Price        58%
  Edge               +14.0%  (very_high confidence)

  Top Drivers
  1. Bitcoin ETF inflows accelerating            impact: high
  2. Halving cycle momentum                      impact: high
  3. Macro risk-on sentiment                     impact: moderate

  Kelly Sizing
  Recommended: 3 shares YES at $0.58
  Risk gates: ✓ Kelly  ✓ Liquidity  ✓ Correlation  ✓ Concentration  ✓ Drawdown

> trust fed-decision-in-september-762

  Trust Index — fed-decision-in-september-762 · Fed Decision in September?

  ██████████████████░░░░░░░░░░░░   59  ● Caution

  HOW IT ADDS UP
  Integrity       80% of score   54  ● Caution
  Trade quality   20% of score   76  ● Good
  ──────────────────────────────────────────────
  = Trust score                  59  ● Caution

  TRUST PROFILE
  Integrity   4 screens run · 3 don't apply · 3 awaiting data
    Market integrity     74  ● Good
    Info fairness        30  ● High Risk
    Resolution quality   60  ● Caution
  Trade quality
    Liquidity            75  ● Tradeable
    Move quality         70  ● Stable
    Rule clarity         95  ● Clear
```

<sub>`buy` and `portfolio` appear in the command table below but are not enabled yet — see the port status note at the top.</sub>

## Commands

| Command | Description |
|---------|-------------|
| `search [theme\|query]` | Find **events** by theme or keyword (Octagon-backed when key set). `search <event-slug>` drills into that event's markets; `search crypto:btc` narrows a theme |
| `search edge [--min-edge N]` | Scan all markets by model edge (Octagon `markets-with-edge`) |
| `similar <market-slug\|"query">` | Related markets: same event → series → category, or keyword query |
| `events` / `events <event-slug>` | Octagon events list + outcome ladder per event |
| `catalysts upcoming --days N` | Markets closing in the next N days, grouped by week |
| `trust <event-slug>` | Octagon Trust Index — overall score, how Integrity and Trade quality add up, and the trust profile. `--verbose` adds per-contract market quality |
| `trust <event-slug> --market <market-slug>` | Single-market Trader Trust detail card (use `--verbose` for evidence) |
| `report <event-slug>` | Full Octagon markdown report for an event (accepts event slug, market slug, or URL). `--refresh` forces a fresh pull. |
| `themes` (registry) | Editorial narrative buckets — list/show/import/create/delete/add-series |
| `themes report` | 25-theme dashboard with SEO + liquidity |
| `themes audit` | Flag dead themes (high SEO + zero volume) |
| `themes overlap` | Cross-theme dedupe report |
| `wallet [show\|create\|import]` | Create, import, or inspect your Polymarket wallet |
| `analyze <ticker>` | Deep analysis: edge, drivers, Kelly sizing |
| `watch <ticker>` | Live price and orderbook feed |
| `watch --theme <theme>` | Continuous theme scan |
| `buy <slug> <shares> [price] [outcome]` | Buy shares — omit price for a market order |
| `sell <slug> <shares> [price] [outcome]` | Sell shares you hold |
| `orders` | Your resting orders on the CLOB — needs a wallet with a key |
| `cancel <order_id>` | Cancel a resting order, or `--all` for every one |
| `backtest` | Model accuracy scorecard + live edge scanner |
| `portfolio` | Cash, positions, P&L, risk snapshot — needs a wallet |
| `setup` | Re-run setup wizard (inside TUI) |
| `init` | Launch setup wizard from CLI (`polymarket init`) |
| `clear-cache` | Delete local cache and rebuild (`polymarket clear-cache`) |
| `help [command]` | Detailed help for a command |

### Flags

| Flag | Description |
|------|-------------|
| `--json` | JSON output for scripts and agents |
| `--refresh` | Force fresh Octagon report (analyze, report) |
| `--performance` | Include win rate, Sharpe, Brier scores (backtest) |
| `--dry-run` | Scan without persisting edges (watch) |
| `--verbose` | Verbose output |
| `--min-edge <n>` | Minimum edge threshold in pp (backtest default 0.5) |
| `--interval <min>` | Scan interval in minutes (watch) |
| `--live` | Force 15m scan interval (watch) |
| `--days <n>` | Lookback period in days (backtest, default 15) |
| `--max-age <n>` | Reject predictions older than N days (backtest, default = `--days`) |
| `--resolved` | Resolved markets only (backtest) |
| `--unresolved` | Open markets only (backtest) |
| `--category <cat>` | Filter by category (backtest, search edge) |
| `--limit <n>` | Max results to show (search edge, default 20) |
| `--min-volume <n>` | Min per-contract volume (from Octagon snapshot; falls back to lifetime if missing). Backtest default 1. |
| `--min-price <n>` | Min contract price, 0-100 scale (backtest, default 5) |
| `--max-price <n>` | Max contract price, 0-100 scale (backtest, default 95) |
| `--export <path>` | Export per-market CSV (backtest) |
| `--top-k <n>` | Number of results (similar) |
| `--close-before <iso>` | Only markets closing before this timestamp |
| `--series <slug>` | Filter to a series (search, similar) |
| `--sort-by <key>` | Sort key for search edge: edge_pp \| expected_return \| total_volume \| model_probability |
| `-q "text"` | Free-text query for similar |
| `--aggregate-by series` | Roll up search results to the series level |
| `--active-only` | Drop non-active markets (defensive flag — open universe by default) |
| `--series-prefix <prefix>` | Server-side series prefix match (e.g. `bitcoin` matches `bitcoin-above-…`) |
| `--force` | Replace an existing wallet (`wallet import`); override the circuit breaker (`buy`, `sell`) |
| `--yes` | Skip the confirmation prompt (`buy`, `sell`) |
| `--all` | Cancel every resting order (`cancel`) |

### Discovery & Portfolio (Octagon-powered)

The `search`, `similar`, `events` and `trust` commands turn the whole market universe into a queryable database. When `OCTAGON_API_KEY` is set the bot routes searches through Octagon's typed endpoints — keyword market search, related-market lookups, model-vs-market edge rankings, and per-market integrity scores. Without a key, `search` and `search edge` fall back to the local SQLite cache.

```bash
# Free-text + structured search (full-text + filters)
polymarket search "bitcoin price" --category crypto --min-volume 10000 --limit 20

# Edge ranking from Octagon's latest run (server-side, no local pre-fetch)
polymarket search edge --min-edge 5 --limit 10 --sort-by total_volume

# Related markets — same event first, then series, then category
polymarket similar will-bitcoin-reach-110000-by-december-31-2026 --top-k 25
polymarket similar -q "bitcoin" --category crypto
```

### Editorial Theme Dashboard

`themes` is a local registry of editorial narrative buckets (e.g. "AI Race Milestones", "Iran Escalation") that maps to lists of event slugs with optional monthly search-volume annotations. These are *narratives* you curate. No seed file ships yet — build the registry with `themes create` / `themes add-series`, or import your own JSON.

```bash
# Seed from the included starter dataset (25 themes, 173 series mappings)
polymarket themes import

# Browse the registry
polymarket themes list
polymarket themes show "Iran Escalation"

# THE dashboard view: 25-theme grid with SEO + liquidity
polymarket themes report

# Flag dead themes (high SEO + zero active inventory)
polymarket themes audit
#   → Epstein / Celebrity Trials   STALE         4.3M searches, 0 active markets
#   → RFK Jr Changes Health        NO_INVENTORY  422k searches, 0 active markets
#   → AI Race Milestones           TRADEABLE     138M searches, 28 active mkts
#   → Bitcoin Breakout             TRADEABLE     29k searches, 270 active mkts

# Cross-theme dedupe (when a series belongs to multiple themes)
polymarket themes overlap
#   → us-iran-nuclear-agreement   Iran Escalation · Nuclear Renaissance
#   → fed-decision-in-september   Fed Cuts Aggressively · Housing / Mortgage Crisis

# Build/manage your own themes (no Polymarket seed file ships yet — themes are
# yours to define; `themes import <path>` loads your own JSON)
polymarket themes create "My Macro Hedge" --label "..." --tickers us-recession-2027,cpi-above-3-2027
polymarket themes add-series "My Macro Hedge" fed-decision-in-september,unemployment-above-5
polymarket themes set-search-volume "My Macro Hedge" 50000

# Event ↔ outcome ladder
polymarket events --category Politics --limit 10       # top political events by volume
polymarket events fed-decision-in-september-762        # outcome probabilities + per-contract edge

# Catalyst calendar
polymarket catalysts upcoming --days 14 --min-volume 5000 --category Politics
```

### Backtesting

Does the model find real edge? Look back N days, compare what the model said then to where the market is now.

- **Resolved** — scored against settlement (YES=100%, NO=0%)
- **Unresolved** — mark-to-market vs current market price

**Methodology (matches Supabase reference):**
- Per-contract `mp`/`kp` come from `outcome_probabilities` on each Octagon snapshot — no event-level fallback.
- Tradeability gate uses per-contract `volume`/`volume_24h` from the snapshot when present; falls back to lifetime volume for pre-API-change cached snapshots.
- `--min-edge` defaults to 0.5pp so the 0-5% edge bucket stays visible; each signal is tagged with an `edge_bucket` label (`0-5%`, `5-10%`, ..., `90%+`).
- `flat_bet_roi` is capital-weighted: `sum(pnl) / sum(capital)`, where `capital = kp/100` for YES edges and `(100 - kp)/100` for NO edges.

```bash
polymarket backtest                              # 15-day lookback (default)
polymarket backtest --days 30                    # 30-day lookback
polymarket backtest --max-age 14                 # only score predictions <=14d old
polymarket backtest --resolved                   # resolved only
polymarket backtest --unresolved --min-edge 10   # unresolved, 10pp threshold
polymarket backtest --category crypto            # filter by category
polymarket backtest --min-volume 10 --min-price 5 --max-price 95   # tradeable contracts only
polymarket backtest --export results.csv         # per-market detail
```

```text
Octagon Backtest — 15-day lookback (04/02 – 04/17)
══════════════════════════════════════════════════════════

  Events         83
  Markets        247   (142 resolved, 105 unresolved)
  Brier (Octagon)   0.168
  Brier (Market)    0.192
  Skill Score       +12.5%  [95% CI: +4.1% to +20.8%]
  Hit rate          61.4%  [95% CI: 54.2% to 68.1%]
  Flat-bet P&L      +$14.38 (ROI: +7.8%)

RESOLVED (142 markets)
  Ticker                    Model   Mkt Then   Outcome   Edge    P&L
  bitcoin-above-95k-…       72%     58%        YES 100%  +14pp   +$0.42
  ...

UNRESOLVED (105 markets)
  Market                        Model   Mkt Then   Now       Edge    M2M
  bitcoin-above-110k-may-2026   71%     58%        68%       +13pp   +$0.10
  ...
```

## Scripting & Parallel Use

The `bunx polymarket-trading-bot-cli@latest …` form is great for one-off interactive use, but it has two gotchas when you script against it:

**1. Install chatter leaks into `--json` output.** Bun prints lines like `Resolving dependencies` and `Saved lockfile` to stdout *before* our CLI runs, which corrupts JSON pipelines.

**2. Parallel invocations race on the install cache.** Running multiple `bunx polymarket-trading-bot-cli@latest …` calls in parallel can fail with `Failed to link …: EEXIST` and `could not determine executable`. See [oven-sh/bun#12917](https://github.com/oven-sh/bun/issues/12917) for current upstream status — `bunx`'s ephemeral install path isn't covered by the `bun install` global-store fix, so the workarounds below are still the recommended path.

**Recommended pattern for scripts and agents:**

```bash
# Install once globally — this is parallel-safe and emits no install chatter on subsequent runs
bun add -g polymarket-trading-bot-cli

# Then use the `polymarket` binary directly — fan out as much as you want
parallel -j 30 'polymarket analyze {} --json > {}.json' ::: bitcoin-above-95k-by-april-30 ethereum-… …
```

**If you must use `bunx`:**

```bash
# --silent suppresses Bun's install chatter (keeps your CLI's stdout clean)
bunx --silent polymarket-trading-bot-cli@latest analyze bitcoin-above-95k-by-april-30 --json

# For parallel bunx, pre-warm the cache serially first to dodge the link race
bunx --silent polymarket-trading-bot-cli@latest --version    # one-shot, populates cache
parallel -j 30 'bunx --silent polymarket-trading-bot-cli@latest analyze {} --json' ::: bitcoin-above-95k-by-april-30 …
```

Keep `@latest` if you want auto-update on every invocation; drop it after the first run if you've pinned a version and want speed.

## Agent Usage

Every command supports `--json` for structured output, making the bot easy to orchestrate from scripts or AI agents.

```bash
polymarket search crypto --json
polymarket similar bitcoin-above-95k-by-april-30 --top-k 10 --json
polymarket events --category Politics --limit 10 --json
polymarket trust fed-decision-in-september-762 --json
polymarket analyze bitcoin-above-95k-by-april-30 --json
polymarket status --json
```

### JSON Response Format

All responses follow the same envelope:

```json
{
  "ok": true,
  "command": "analyze",
  "data": {
    "ticker": "bitcoin-above-95k-by-april-30",
    "modelProb": 0.72,
    "marketProb": 0.58,
    "edge": 0.14,
    "confidence": "very_high",
    "drivers": [
      { "claim": "Bitcoin ETF inflows accelerating", "impact": "high" }
    ]
  },
  "meta": {
    "octagon_credits_used": 3,
    "octagon_cache_hits": 0
  },
  "timestamp": "2026-03-30T10:00:00.000Z"
}
```

Errors return `"ok": false` with an `error` object containing `code` and `message`. Exit code is 0 for success, 1 for failure.

### Example Orchestration Flow

```bash
# 1. Find markets
MARKETS=$(polymarket search crypto --json | jq '.data')

# 2. Analyze top pick
ANALYSIS=$(polymarket analyze bitcoin-above-95k-by-april-30 --json)
EDGE=$(echo "$ANALYSIS" | jq '.data.edge')

# 3. Trade if edge is high enough
#    (buy is not implemented yet — this is the shape it will take)
if (( $(echo "$EDGE > 0.05" | bc -l) )); then
  polymarket buy bitcoin-above-95k-by-april-30 3 0.58 --json
fi
```

The `watch --theme` command outputs NDJSON (one JSON object per scan cycle), suitable for streaming pipelines.

## Configuration

### Environment Variables

The setup wizard (run automatically on first launch, or invoke with `polymarket init`) writes `~/.polymarket-bot/.env` for you. Edit that file directly to change anything below.

> **There is no testnet.** Polymarket runs a single environment, so every order this tool places is real money. Nothing here is a paper-trading mode.

**Required:**

Polymarket market data is public, so there is no exchange key to set — reads work with no credentials at all.

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (default model is GPT-5.4) |
| `OCTAGON_API_KEY` | Octagon API key. Powers deep research (`analyze`), edge scanning (`search edge`), and the Octagon-backed discovery commands (`search`, `similar`, `events`, `trust`, `report`). Get one at [app.octagonai.co](https://app.octagonai.co) |

**Optional:**

| Variable | Description |
|----------|-------------|
| `DEFAULT_MODEL` | Override the default LLM (default `gpt-5.4`) |
| `POLYMARKET_GAMMA_URL` / `POLYMARKET_CLOB_URL` / `POLYMARKET_DATA_URL` | Override an individual service base URL, for a local proxy or mock |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `XAI_API_KEY` | xAI (Grok) |
| `OPENROUTER_API_KEY` | OpenRouter (multi-model) |
| `TAVILY_API_KEY` | Tavily web search for event research |
| `POLYMARKET_PRIVATE_KEY` | Signing key, overriding `~/.polymarket-bot/wallet.json` for one session |
| `POLYMARKET_WALLET_ADDRESS` | Read-only funding address, when you do not want a key on the machine |
| `POLYMARKET_RPC_URL` | Polygon RPC (default `https://polygon.drpc.org`) |

> **Note:** The bot defaults to GPT-5.4. If using a different provider, switch the model via the `config` command — otherwise queries will fail without `OPENAI_API_KEY`.

### Octagon Credits

Each Octagon report costs 3 credits. Reports are cached with tiered TTLs based on market close proximity — markets closing soon get shorter cache windows. Use `--refresh` to force a fresh report. Set a daily credit ceiling with `config octagon.daily_credit_ceiling <n>`.

### Wallet

Research and market data need no wallet. Reading your balance, positions and P&L
needs one, and placing trades needs its private key.

**Start on polymarket.com.** Create your account there and fund it, then bring
that key here. There is no `wallet create`: a wallet generated by this CLI would
be a fresh account with no Polymarket history, and the site deposits only into
the account it made for you.

```bash
polymarket wallet import <private-key>  # your polymarket.com key — enables trading
polymarket wallet import <address>      # read-only: balances and positions
polymarket wallet show                  # addresses, wallet type, mode, key source
```

A Polymarket account has **two** addresses, and confusing them is the classic
way to see a zero balance on a funded account:

| | |
|---|---|
| **Signing wallet** | The keypair. Signs orders, pays gas in POL. Holds nothing. |
| **Funding wallet** | A contract it controls. Holds your pUSD. **Deposit here.** |

`wallet show` prints both. Which contract is the funding wallet depends on when
your account was made — recent ones get a *deposit wallet*, older ones a *proxy*
or a *Safe* — and it is not computable from the key alone. So `wallet import`
asks Polymarket once and records the answer; `wallet show` reports which kind
you have. An address you paste is taken as the *funding* wallet, which is what
your polymarket.com profile shows and what the Data API calls `proxyWallet`.

**Whatever the key controls, this CLI controls.** The private key is stored on
this machine, so keep in that account only what you intend to trade.

The key is written to `~/.polymarket-bot/wallet.json` with owner-only (`0600`)
permissions — never to `.env`, which this CLI writes world-readable and which
is easy to commit by accident. `POLYMARKET_PRIVATE_KEY` overrides the saved file
for a single session; pair it with `POLYMARKET_WALLET_ADDRESS`, since the
funding address cannot be derived from the key.

#### Trading approvals

Trading needs on-chain permissions for the exchange contracts to move your pUSD
and your outcome tokens. **Polymarket grants them during onboarding** — a live
account was verified with all seven in place, having never traded and without
this CLI ever touching it — so there is nothing to do here and no command for
it. If one were ever missing, the venue rejects the order and says so, and
placing a single trade on polymarket.com prompts for it.

This CLI signs no on-chain transactions at all: orders are EIP-712 messages that
Polymarket settles, so you never need POL for gas.

### Bankroll

With a wallet configured, position sizing uses your on-chain **pUSD** balance
automatically — nothing to set.

`risk.bankroll_usdc` is an optional **cap** on top of that, for when the wallet
holds more than you want this bot to trade:

```bash
polymarket config risk.bankroll_usdc 1000
```

The two combine as `min(wallet balance, cap − open exposure)`. Open exposure is
subtracted from the cap but **not** from the wallet balance, because positions
are held as outcome tokens rather than as reserved cash — the balance is already
net of them.

| Wallet | `risk.bankroll_usdc` | Sizing uses |
|---|---|---|
| yes | unset | the wallet balance |
| yes | set | the lower of the two |
| no | set | the cap, less open exposure |
| no | unset | nothing — `analyze` reports edge but skips sizing |

Without either, `analyze` still reports edge, probabilities and catalysts, but
skips sizing with *"No bankroll available"* rather than sizing against a number
it does not have.

If the balance cannot be read — an unreachable RPC, say — that is reported as
*unknown*, never as zero. A failed read must not look like an empty account.

### Runtime Settings

```bash
polymarket config                              # List all settings
polymarket config risk.kelly_multiplier        # Get a value
polymarket config risk.kelly_multiplier 0.3    # Set a value
```

| Setting | Default | Description |
|---------|---------|-------------|
| `scan.interval` | `60` | Scan interval in minutes |
| `scan.theme` | `top50` | Default market theme |
| `risk.bankroll_usdc` | `0` | Capital that sizing assumes; `0` disables sizing |
| `risk.kelly_multiplier` | `0.5` | Kelly fraction (0.5 = half-Kelly) |
| `risk.max_drawdown` | `0.20` | Max drawdown before circuit breaker |
| `risk.max_positions` | `10` | Max concurrent open positions |
| `risk.max_per_category` | `3` | Max positions per event category |
| `risk.daily_loss_limit` | `200` | Daily loss limit in dollars |
| `octagon.daily_credit_ceiling` | `100` | Max Octagon credits per day |
| `alerts.min_edge` | `0.05` | Minimum edge to trigger an alert |

## Architecture

The CLI talks to two external services: the Polymarket exchange API (market data; order placement and portfolio reads are not enabled yet) and the Octagon research API (AI probability estimates, price drivers). Results are cached in a local SQLite database to minimize API calls and credit usage.

### LLM Providers

Default model is GPT-5.4. Switch with the `config` command.

| Prefix | Provider |
|--------|----------|
| `gpt-` | OpenAI |
| `claude-` | Anthropic |
| `gemini-` | Google |
| `grok-` | xAI |
| `openrouter/` | OpenRouter |
| `ollama:` | Ollama (local) |

### Development

```bash
bun dev              # Dev mode with hot reload
bun run typecheck    # Type checking
bun test             # Run tests
```

## Telemetry

This app collects anonymous usage telemetry to help improve the product.
**No personal data, API keys, trade details, or natural language inputs are ever collected.**
Only command names, tool usage, timing, and success/failure metrics are tracked.

Telemetry is enabled by default. To disable it, add to your `.env`:

```bash
TELEMETRY_ENABLED=false
```

Or set the environment variable before running:

```bash
TELEMETRY_ENABLED=false bunx polymarket-trading-bot-cli@latest
```

## Documentation

See the [User Guide](GUIDE.md) for detailed usage instructions, examples, and tips.

## Star History

<a href="https://star-history.dera.page/#OctagonAI/polymarket-trading-bot-cli&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=OctagonAI/polymarket-trading-bot-cli&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=OctagonAI/polymarket-trading-bot-cli&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=OctagonAI/polymarket-trading-bot-cli&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT License — see [LICENSE](LICENSE) for details.
