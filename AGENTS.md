# Repository Guidelines

A CLI + TUI for AI-assisted prediction market research and trading on **Polymarket**, built with TypeScript on Bun.

> **Port in progress.** This repo began as a clone of `kalshi-trading-bot-cli` and is being ported to Polymarket
> one phase at a time. Code under `src/tools/kalshi/` and the Octagon Kalshi client still target Kalshi; they are
> replaced in later phases. Rebrand cosmetic strings freely, but do not rename Kalshi *code identifiers* ahead of
> the phase that replaces them.

## Project Structure

- Source: `src/`
  - Entry point: `src/index.tsx` (shebang `#!/usr/bin/env bun`) → `src/cli.ts` (TUI) or `src/commands/dispatch.ts` (batch CLI)
  - TUI: `src/cli.ts` (built on `@mariozechner/pi-tui`, **not** Ink/React), widgets in `src/components/`, controllers in `src/controllers/`
  - Commands: `src/commands/` — one file per subcommand, plus `parse-args.ts`, `help.ts`, `dispatch.ts`, `index.ts` (slash handler), formatters
  - Agent: `src/agent/` (LangChain loop, prompts, tool executor)
  - Exchange client: `src/tools/kalshi/` — the single HTTP chokepoint (`callKalshiApi`), retry/DLQ, domain types
  - Octagon research: `src/scan/` (`octagon-kalshi-api.ts`, `octagon-events-api.ts`, `octagon-client.ts`, `invoker.ts`, edge computation, theme resolution)
  - Persistence: `src/db/` (`bun:sqlite`, schema + repos), `src/utils/paths.ts` owns all on-disk locations
  - Risk: `src/risk/` (Kelly sizing, correlation, gate, circuit breaker)
  - Backtest: `src/backtest/`; Gateway (WhatsApp/Baileys): `src/gateway/`; Setup wizard: `src/setup/wizard.ts`
  - Also: `src/audit/`, `src/eval/`, `src/model/llm.ts`, `src/providers.ts`, `src/theme.ts`, `src/utils/`
- On disk (all under `~/.polymarket-bot/`, via `src/utils/paths.ts`): `.env`, `settings.json`, `config.json`, `polymarket-bot.db`, `dlq.jsonl`
- Seed data: `data/themes_seo.json`. Scripts: `scripts/release.sh`, `scripts/test-commands*.ts`

## Build, Test, and Development Commands

- Runtime: **Bun ≥ 1.1** (required — uses `bun:sqlite` and runs `.tsx` directly; Node will not work)
- Install: `bun install` · Run: `bun run start` · Watch: `bun run dev`
- Type-check: `bun run typecheck` · Tests: `bun test` · Integration: `bun run test:integration` (`**/*.itest.ts`)
- Gateway: `bun run gateway:login`, `bun run gateway`
- CI runs `bun run typecheck` and `bun test` on push to `main` and on PRs.

## Coding Style & Conventions

- TypeScript, ESM, strict mode. Prefer strict typing; avoid `any`.
- Keep files concise; extract helpers rather than duplicating code.
- Brief comments for non-obvious logic only. Do not add logging unless asked.
- Do not create README or documentation files unless asked.
- No linter or formatter is configured — match surrounding style.

## Command Changes — Keep Nine Files In Sync

When a command's flags or signature change, update **all** of: `src/commands/parse-args.ts`, `src/commands/help.ts`,
`src/commands/index.ts`, `src/commands/dispatch.ts`, `src/cli.ts` (autocomplete `slashCommands`),
`src/components/intro.ts`, `README.md`, `src/__tests__/e2e.test.ts`, `src/gateway/commands/handler.ts`.
This is the single largest source of drift in the repo — see `CLAUDE.md`.

## LLM Providers

- Registry in `src/providers.ts`: OpenAI (default), Anthropic, Google, xAI, Moonshot, DeepSeek, OpenRouter, Ollama (local).
- Default model `gpt-5.4`; chat models wired via LangChain in `src/model/llm.ts`. Users switch with `/model`.

## Tools

Registered in `src/tools/registry.ts`, conditionally by env var:
`kalshi_search` (market research router), `kalshi_trade` (trade execution router, requires approval —
see `TOOLS_REQUIRING_APPROVAL` in `src/agent/tool-executor.ts`), `octagon_report`, `portfolio_overview`,
`portfolio_query`, `portfolio_review`, `edge_query`, `risk_status`, `scan_markets`, `exchange_status`,
`web_search` (Tavily), `web_fetch`.

## Environment Variables

- Exchange: `POLYMARKET_API_KEY`, `POLYMARKET_PRIVATE_KEY_FILE` / `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_USE_DEMO`
- Research: `OCTAGON_API_KEY`, `OCTAGON_BASE_URL`, `OCTAGON_CONCURRENCY`
- LLM: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `DEFAULT_MODEL`
- Other: `TAVILY_API_KEY`, `TELEMETRY_ENABLED`
- Never commit `.env` files or real API keys.

## Version & Release

- SemVer, tag prefix `v`. Pushing a `package.json` version change to `main` auto-tags and publishes via npm OIDC
  Trusted Publishing (`.github/workflows/release-tag.yml` → `publish-npm.yml`).
- **That workflow is currently gated behind repository variable `RELEASE_ENABLED=true`** while the package rename
  lands — OIDC trust is configured per-package and must be set up for `polymarket-trading-bot-cli` first.
- Do not push or publish without user confirmation.

## Testing

- Bun's built-in test runner only (no Jest). Tests colocated in `__tests__/` dirs or as `*.test.ts` siblings.
- `*.itest.ts` are integration tests that hit live APIs; they are excluded from `bun test`.
- Run `bun test` before pushing when you touch logic.

## Security

- API keys live in `~/.polymarket-bot/.env` (or a CWD `.env`, which takes precedence). Keys can also be entered
  interactively via the setup wizard.
- Never commit or expose real API keys, tokens, or credentials.
