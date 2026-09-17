# Polymarket Trading Bot CLI — User Guide

AI-powered prediction market terminal for [Polymarket](https://polymarket.com). Ask natural language questions and research markets from your terminal.

> **Trading is live.** `/buy`, `/sell`, `/orders` and `/orders cancel` place and manage
> real orders once a wallet is imported. `/portfolio` is gated with
> them because every view it offers needs a configured wallet.
> Market data and research need no credentials at all.

---

## Getting Started

### Prerequisites

- **[Bun](https://bun.com/) ≥ 1.1** — required. The bot uses `bun:sqlite` and runs `.tsx` directly, so Node.js will not work.
  ```bash
  curl -fsSL https://bun.com/install | bash
  ```
- A **Polymarket** account (a Polygon wallet with USDC) — required for trading only
- At least one **LLM API key** (OpenAI, Anthropic, Google, xAI, OpenRouter, or a local Ollama)
- Optional: **[Octagon](https://app.octagonai.co)** key for AI edge analysis, **Tavily** key for web research

### Setup

```bash
bunx polymarket-trading-bot-cli@latest
```

That's it — no clone required. The setup wizard runs automatically on first launch and writes your API keys to `~/.polymarket-bot/.env`.

The wizard also asks about a **bankroll**. With a wallet configured you can leave it empty: sizing reads your on-chain **pUSD** balance. Set a figure only to cap risk below that balance. Without a wallet there is nothing to read, so the figure is the only thing sizing has:

```bash
polymarket config risk.bankroll_usdc 1000
```

Skipping it is fine — research works without it. `analyze` will still report edge, probabilities and catalysts, but skips position sizing with *"No bankroll configured"* rather than sizing against a number it does not have. It is not a deposit; it is only the figure Kelly sizing and the risk gate work from.

Other ways to run it:

```bash
bun add -g polymarket-trading-bot-cli  # then just `polymarket`
```

Or from a clone (development):

```bash
git clone https://github.com/OctagonAI/polymarket-trading-bot-cli.git
cd polymarket-trading-bot-cli
bun install
bun start        # or `bun run dev` for hot-reload
```

### Where things live

- **Config, cache, SQLite DB:** `~/.polymarket-bot/`
- **API keys (`.env`):** `~/.polymarket-bot/.env`. A `.env` in the current directory takes precedence (dev override).

### Environment Variables

Polymarket market data is public — no credentials are needed to research. Reading
your own balance and positions needs a wallet address; trading needs its private
key. Prefer `polymarket wallet import` over setting these by hand: it writes
`~/.polymarket-bot/wallet.json` with owner-only permissions, whereas `.env` is
written world-readable. `POLYMARKET_PRIVATE_KEY` needs `POLYMARKET_WALLET_ADDRESS`
alongside it — the funding address cannot be derived from the key.

| Variable | Required | Description |
|---|---|---|
| `POLYMARKET_GAMMA_URL` / `POLYMARKET_CLOB_URL` / `POLYMARKET_DATA_URL` | No | Override an individual service base URL, for a local proxy or mock |
| `OPENAI_API_KEY` | One of these | OpenAI API key |
| `ANTHROPIC_API_KEY` | One of these | Anthropic API key |
| `GOOGLE_API_KEY` | One of these | Google AI API key |
| `XAI_API_KEY` | One of these | xAI API key |
| `OPENROUTER_API_KEY` | One of these | OpenRouter API key |
| `OLLAMA_BASE_URL` | No | Ollama endpoint (default `http://127.0.0.1:11434`) |
| `TAVILY_API_KEY` | No | Enables web search tool for background research |
| `POLYMARKET_PRIVATE_KEY` | No | Signing key; overrides the saved wallet for one session |
| `POLYMARKET_WALLET_ADDRESS` | No | Read-only funding address, with no key on the machine |
| `POLYMARKET_RPC_URL` | No | Polygon RPC (default `https://polygon.drpc.org`) |
| `LANGSMITH_API_KEY` | No | LangSmith tracing for debugging |


---

## How It Works

The bot runs an **AI agent loop** (up to 10 iterations) that can reason, call tools, inspect results, and call more tools before delivering a final answer. You interact via two modes:

1. **Natural language** — type any question and the agent researches it using its tools
2. **Slash commands** — quick shortcuts for common actions (see below)

### Switching Models

Type `/model` to pick your LLM provider and model. Your choice persists across sessions. Supported providers: OpenAI, Anthropic, Google, Ollama (local), and OpenRouter (any model).

---

## Slash Commands

Quick commands that bypass the AI agent and call the exchange or Octagon API directly.

| Command | Description | Example |
|---|---|---|
| `/help` | Show all available commands | `/help` |
| `/status` | Setup check: connectivity, API keys | `/status` |
| `/wallet` | Show your wallet: addresses, wallet type, mode | `/wallet` |
| `/wallet import <key\|address>` | Import your polymarket.com wallet (key = trading, address = read-only) | `/wallet import 0x…` |
| `/balance` | Free pUSD in your funding wallet | `/balance` |
| `/positions` | Open positions with P&L | `/positions` |
| `/orders` | Resting (open) orders | `/orders` |
| `/orders <id>` | One resting order in full, by id or short prefix | `/orders 0xb726a9d0` |
| `/orders cancel <id>` | Cancel a resting order (`--all` for every one) | `/orders cancel 0xb726a9d0` |
| `/markets [series]` | Browse markets, optionally filter by series slug | `/markets bitcoin` |
| `/market <market-slug>` | Market detail + top-of-book orderbook | `/market bitcoin-above-95k-by-april-30` |
| `/search <query>` | Full-text market search (Octagon when key set) | `/search "bitcoin price" --min-volume 10000` |
| `/search edge` | Edge ranking from Octagon's latest run | `/search edge --min-edge 5 --sort-by total_volume` |
| `/similar <slug\|"text">` | Related markets (event → series → category) | `/similar will-bitcoin-reach-110000-by-december-31-2026 --top-k 20` |
| `/events` / `/events <event-slug>` | Octagon events + outcome ladder | `/events fed-decision-in-september-762` |
| `/catalysts upcoming` | Markets closing soon, grouped by week | `/catalysts upcoming --days 14` |
| `/themes` (registry) | Editorial narrative buckets | `/themes show "Iran Escalation"` |
| `/themes report` | 25-theme dashboard with SEO + liquidity | `/themes report` |
| `/themes audit` | Flag dead themes (high SEO + zero volume) | `/themes audit` |
| `/themes overlap` | Cross-theme dedupe report | `/themes overlap` |
| `/buy <market-slug> <shares> [price]` | Buy shares (price 0-1; omit for a market order) | `/buy bitcoin-above-95k-by-april-30 5 0.56` |
| `/sell <market-slug> <shares\|max> [price]` | Sell shares you hold (`max` = the whole position) | `/sell bitcoin-above-95k-by-april-30 max` |

**Trading is not available yet.** These commands return an explanation instead of
placing an order; Polymarket orders need EIP-712 wallet signing and on-chain
USDC/CTF allowances. When they land, `/buy` and `/sell` will show a confirmation
prompt before executing.

**Price format:** Prices are decimal USDC in [0, 1]. `0.56` = $0.56 per share = 56% implied probability. Omit the price on `/buy` or `/sell` for a market order.

---

## Discovery & Portfolio (Octagon-powered)

With `OCTAGON_API_KEY` set, the bot routes searches through Octagon's typed endpoints. This unlocks related-market lookups, thematic and behavioral clustering, pairwise correlation matrices, and one-call diversified basket construction. Without a key the bot falls back to the local SQLite index for `/search` and `/search edge`; the other commands require the key.

### `/search` and `/search edge`

```bash
# Server-side full-text + structured filter
polymarket search "bitcoin price" --category crypto --min-volume 10000 --limit 20

# Edge ranking from Octagon's latest events run
polymarket search edge --min-edge 5 --limit 10 --sort-by total_volume
polymarket search edge --category politics --sort-by edge_pp
```

Flags (server-side path): `--category`, `--series <ticker>`, `--min-volume <n>`, `--close-before <iso>`, `--limit <n>`, `--sort-by <edge_pp|expected_return|total_volume|model_probability>`.

### `/similar`

Finds markets *related* to an anchor. This is not semantic search — it will not
match "Will Bitcoin pierce six figures" to "BTC > $100k". Use `/search` for that.

```bash
polymarket similar will-bitcoin-reach-110000-by-december-31-2026 --top-k 25   # anchor by market slug
polymarket similar -q "bitcoin" --category crypto
polymarket similar -q "ethereum staking" --category crypto --min-volume 10000 --close-before 2026-08-19T00:00:00Z
```

Ordering depends on the anchor:

- **Market slug** — a taxonomy walk: markets in the anchor's own event first, then
  its series, then its category, each tier sorted by 24h volume.
- **`-q "text"`** — keyword relevance (the same ranking the market list uses),
  then 24h volume.

The `distance` field in `--json` output is `row_number() / 1000`. It restates row
order and nothing else: it is not a similarity metric and is not comparable
across responses, so a cutoff like `distance < 0.2` just means "the first 199 rows".

### Editorial Themes — narrative registry

Editorial themes are user-curated narrative buckets (e.g. "AI Race Milestones", "Iran Escalation") that map to lists of event slugs. These are *narratives* you define.

No seed file ships yet, so the registry starts empty — build it up with `themes create` and `themes add-series`, or import your own JSON.

```bash
polymarket themes list
polymarket themes import ~/my-themes.json

# Drill into one
polymarket themes show "Iran Escalation"
#  Description    Hormuz traffic, US-Iran nuclear deal, oil & gas price ladders
#  Search volume  1.1M/month
#  Series         3 mapped
#  strait-of-hormuz-traffic-returns-to-normal-by-december-31, us-iran-nuclear-agreement, ...

# Identify dead themes (high SEO but no inventory)
polymarket themes audit
#   Status keys:
#     STALE         — high SEO, all series exist but 0 active markets
#     NO_INVENTORY  — high SEO, no series mapped at all
#     THIN          — active markets but <$1000/day volume
#     TRADEABLE     — ready to act on

# Cross-theme dedupe — same series in two themes
polymarket themes overlap
#   us-iran-nuclear-agreement    Iran Escalation · Nuclear Renaissance
#   fed-decision-in-september    Fed Cuts Aggressively · Housing / Mortgage Crisis
```

#### Build your own themes

```bash
polymarket themes create "My Macro Hedge" --label "Recession + inflation tail" --tickers us-recession-2027,cpi-above-3-in-2027
polymarket themes add-series "My Macro Hedge" fed-decision-in-september,unemployment-above-5-in-2027
polymarket themes set-search-volume "My Macro Hedge" 50000
polymarket themes export ~/my-themes.json    # version-control or share
polymarket themes import ~/my-themes.json    # restore on another machine
polymarket themes delete "My Macro Hedge"
```

#### Compose with baskets

```bash
# Backtest the entire theme as an equal-weight NAV (top market per series)
polymarket basket backtest --theme "Iran Escalation" --timeframe 3m

# OHLC bars for theme momentum
polymarket basket candles --theme "Fed Cuts Aggressively" --timeframe 1y --json
```

### Events — outcome ladders

`events` exposes Octagon's event-level rollups, where each event is a multi-market question (e.g. "Who will Trump nominate as Fed Chair?") with per-outcome model probabilities.

```bash
polymarket events --category Politics --limit 10
polymarket events fed-decision-in-september-762   # outcome ladder with per-contract edge
```

### Catalyst calendar

```bash
polymarket catalysts upcoming                              # next 30 days
polymarket catalysts upcoming --days 7 --min-volume 5000   # liquid markets, next week
polymarket catalysts upcoming --category Politics
```

Groups markets by ISO week of `close_time` so you can see catalyst clustering and position before risk concentration.

---

## Natural Language Queries

This is the primary way to use the bot. The AI agent has access to all the tools below and will chain them together automatically.

### Example Queries

**Market research:**
- "What are the odds of Trump winning in 2028?"
- "Show me all open Bitcoin markets"
- "What's the implied probability of the Fed cutting rates this month?"
- "Find markets related to AI regulation"

**Price and data:**
- "What's the current price of bitcoin-above-95k-by-april-30?"
- "Show me the orderbook for bitcoin-above-95k-by-april-30"
- "Give me a price history chart for this market over the last week"

**Portfolio:**
- "What's my balance?"
- "Show me my open positions and P&L"
- "List my recent fills"
- "Do I have any resting orders?"

**Trading (requires confirmation):**
- "Buy 10 YES shares of bitcoin-above-95k-by-april-30 at $0.55"
- "Sell my position in bitcoin-above-95k-by-april-30"
- "Cancel all my resting orders"
- "Place a limit order: 5 YES on presidential-election-winner-2028 at $0.30"

**Web research:**
- "What's the latest news about the 2028 presidential race?"
- "Search for recent Bitcoin ETF developments"

---

## Tool Reference

The agent has access to the following tools. You never call these directly — the agent selects them based on your query.

### polymarket_search (Market Research Router)

The primary research tool. Takes your natural language query and automatically routes to the right Polymarket API endpoints (Gamma / CLOB / Data) across up to **3 iterations** (browse → drill down → analyze).

**How it works:**
1. An LLM reads your query and decides which sub-tools to call
2. Sub-tool results are collected and the LLM decides if it needs more data
3. If so, it calls additional sub-tools (e.g., drilling into a specific event for contract prices)
4. After at most 3 iterations (or when the LLM has enough data), combined results are returned

**Sub-tools available to the router:**

#### Market Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `get_markets` | List/browse markets | `event_ticker`, `series_ticker`, `status` (open/closed/settled), `tickers[]`, `limit` |
| `get_market` | Single market details | `ticker` (required) |
| `get_market_orderbook` | Order book depth (bid/ask levels) | `ticker` (required), `depth` |
| `get_market_candlesticks` | OHLC price history | `ticker` (required), `start_ts`, `end_ts`, `period_interval` (minutes) |

#### Event & Series Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `get_events` | Browse/list events | `status`, `series_ticker`, `with_nested_markets`, `limit` |
| `get_event` | Single event with optional nested markets | `event_ticker` (required), `with_nested_markets` |
| `get_series` | Series metadata and settlement sources | `series_ticker` (required) |

#### Portfolio Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `get_balance` | Account balance | *(none)* |
| `get_positions` | Open positions | `event_ticker`, `ticker` |
| `get_fills` | Trade executions/fills | `ticker`, `order_id`, `min_ts`, `max_ts`, `limit` |
| `get_settlements` | Resolved market settlements | `ticker`, `limit` |
| `get_orders` | Order history | `ticker`, `event_ticker`, `status` (resting/canceled/executed/all), `limit` |
| `get_order` | Single order details | `order_id` (required) |

#### Historical Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `get_historical_markets` | Past/closed markets | `series_ticker`, `event_ticker`, `status`, `limit` |
| `get_historical_market` | Single historical market | `ticker` (required) |
| `get_historical_candlesticks` | Historical OHLC data | `ticker` (required), `start_ts`, `end_ts`, `period_interval` |
| `get_historical_fills` | Historical fills | `ticker`, `limit` |
| `get_historical_orders` | Historical orders | `ticker`, `limit` |

#### Exchange Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `get_exchange_status` | Is the exchange open/trading? | *(none)* |
| `get_exchange_schedule` | Trading hours and maintenance windows | *(none)* |

### polymarket_trade (Trade Execution Router)

Routes natural language trade instructions to the appropriate trading action. **Always requires user approval** before executing.

> **Note.** The agent never places an order itself. This tool explains what to run,
> so that spending money stays an explicit act by the user.

**Sub-tools:**

| Tool | Purpose | Key Parameters |
|---|---|---|
| `place_order` | Place a single order | `slug`, `action` (buy/sell), `side` (yes/no), `type` (limit/market), `shares`, `price` (0-1 USDC) |
| `amend_order` | Modify a resting order | `order_id`, `count`, `yes_price`, `expiration_ts` |
| `cancel_order` | Cancel one order | `order_id` |
| `cancel_orders` | Batch cancel | `order_ids[]` |
| `place_batch_orders` | Place multiple orders at once | `orders[]` (array of order specs) |

### portfolio_overview

Quick composite tool that fetches balance + all positions in a single call.
Registered only when a wallet is configured — with no wallet there is no account
to read, so the agent is not offered it. `portfolio_review` is registered on the
same condition.

### exchange_status

Reachability check against the Polymarket CLOB. Polymarket trades 24/7, so there
are no exchange hours to report.

### web_search

Searches the web for current events, news, and background research (powered by Tavily). Only available if `TAVILY_API_KEY` is set.

### web_fetch

Fetches and parses content from a specific URL. Used for reading articles, press releases, or any web content referenced in market research.

---

## Identifiers

Polymarket identifies things by **slug**, not by a ticker code. There are four levels:

| Level | Example | Description |
|---|---|---|
| Series | `nfl` | A recurring topic |
| Event | `fed-decision-in-september-762` | A specific occurrence, and the `polymarket.com/event/<slug>` path |
| Market | `will-the-fed-decrease-interest-rates-by-25-bps-…` | One outcome question within an event |
| Outcome token | `71321045679252212594626385532706912750332728571942532289631379312455583992563` | The YES or NO side of a market, as a uint256 decimal string |

A market also has a `conditionId` (`0x…`), which commands accept anywhere a market slug is accepted.
An outcome token id is what identifies a side of a market — never parse it as a JavaScript number, it exceeds Number.MAX_SAFE_INTEGER.

**Price interpretation:** prices are **decimal USDC in [0, 1]**. A price of `0.56` means $0.56 per
share, which implies a **56% probability** of that outcome. YES + NO prices sum to approximately
`1.00`. Tick size is `0.01` or `0.001` depending on the market, and the minimum order is 5 shares.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Submit message |
| `Esc` | Cancel current action (agent execution, model selection) |
| `Ctrl+C` | Exit the app |
| Up/Down arrows | Navigate input history |

---

## Tips

- **No testnet**: Polymarket runs one environment. There is no demo, sandbox or paper-trading mode — every order is real money
- **Multi-step research**: The search router automatically drills down — ask "what's the implied probability of X" and it will find the event, then fetch contract-level prices
- **Be specific**: "BTC markets closing this week" works better than "crypto"
- **Trade safely**: when trading lands, all orders will require explicit confirmation — the agent shows the order details and asks for approval
- **Web + Markets**: Combine web search with market data — "what's the latest polling for 2028 and how do market odds compare?"
