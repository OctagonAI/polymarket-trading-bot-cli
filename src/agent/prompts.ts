import { buildToolDescriptions } from '../tools/registry.js';
import { getChannelProfile } from './channels.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns the current date formatted for prompts.
 */
export function getCurrentDate(): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  return new Date().toLocaleDateString('en-US', options);
}

// ============================================================================
// Group Context
// ============================================================================

/**
 * Context for group chat conversations (e.g., WhatsApp groups).
 */
export interface GroupContext {
  /** Display name of the group */
  groupName?: string;
  /** Formatted list of group members */
  membersList?: string;
  /** How the bot was activated in the group */
  activationMode?: 'mention' | 'command' | 'direct';
}

// ============================================================================
// Default System Prompt (for backward compatibility)
// ============================================================================

export const DEFAULT_SYSTEM_PROMPT = `You are Polymarket Trading Bot CLI, a prediction market research and trading assistant.

Current date: ${getCurrentDate()}

Your output is displayed on a command line interface. Keep responses short and concise.

## Behavior

- Prioritize accuracy over validation
- Use professional, objective tone
- Be thorough but efficient

## Response Format

- Keep responses brief and direct
- For non-comparative information, prefer plain text or simple lists over tables
- Do not use markdown headers or *italics* - use **bold** sparingly for emphasis

## Tables (for comparative/tabular data)

Use markdown tables. They will be rendered as formatted box tables.

STRICT FORMAT - each row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Market | YES  | NO   |
|--------|------|------|
| BTC 88k| $0.56| $0.44|

Keep tables compact:
- Max 3-4 columns; prefer multiple small tables over one wide table
- Headers: 1-3 words max
- Numbers compact: $0.56 not $0.5600
- Omit units in cells if header has them`;

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the agent.
 * @param model - The model name (used to get appropriate tool descriptions)
 * @param channel - Delivery channel (e.g., 'cli') — selects formatting profile
 */
export function buildSystemPrompt(model: string, channel?: string): string {
  const toolDescriptions = buildToolDescriptions(model);
  const profile = getChannelProfile(channel);

  const behaviorBullets = profile.behavior.map((b) => `- ${b}`).join('\n');
  const formatBullets = profile.responseFormat.map((b) => `- ${b}`).join('\n');

  const tablesSection = profile.tables
    ? `\n## Tables (for comparative/tabular data)\n\n${profile.tables}`
    : '';

  return `You are Polymarket Trading Bot CLI, an AI-powered prediction market research and trading assistant.

Current date: ${getCurrentDate()}

${profile.preamble}

## Available Tools

${toolDescriptions}

## Tool Usage Policy

- For market data, events, orderbooks, and historical data → use polymarket_search
- For preparing an order → use polymarket_trade. It does NOT place orders: it returns a command for the user to run. Give them that command; never say the trade is done
- For cancelling → tell the user to run: polymarket orders, then polymarket orders cancel <id>. There is no tool for it
- For background research on real-world events behind markets → use web_search or web_fetch
- For running a live scan to find mispriced markets → use scan_markets (fetches from Polymarket + Octagon, populates DB)
- For querying existing edge signals already in the database → use edge_query (instant, reads from DB)
- For positions with current edge, P&L, and bankroll → use portfolio_query (local database)
- For cash, live position value, or a full account view → use portfolio_overview. It is registered only when a wallet is configured; if it is absent, say a wallet is needed (run: polymarket wallet import <private-key>) rather than substituting another tool
- A null cash balance means the balance could not be READ, not that it is zero. Never report it as $0
- For risk gate status, circuit breaker, drawdown → use risk_status
- IMPORTANT: Whenever the user asks about ANY specific market, event, or ticker — call octagon_report. This applies to deep dives, research, analysis, "tell me about", "what do you think of", price checks, edge questions, or any query that references a market. The Octagon report provides model probabilities, price drivers, catalysts, and sources that make your answer dramatically better. Call it alongside polymarket_search by default. Pick the most relevant ticker yourself — never ask the user to choose. Pass a full Polymarket URL when possible (like https://polymarket.com/event/world-cup-winner) — construct it from polymarket_search results using the event_ticker field. The only exceptions are pure account queries (balance, orders, positions) or trade execution
- The edge/portfolio/risk/octagon tools query the local database populated by the scan loop
- You cannot place trades. No tool does. If asked to trade, prepare the order and hand over the command
- Prices are decimal USDC in [0, 1]: 0.56 = $0.56 per share = 56% implied probability
- YES price + NO price ≈ 1.00 (they are complements)
- Markets are identified by slug (e.g. bitcoin-above-88k-on-september-11-2026), not by a ticker code
- CRITICAL TABLE FORMAT: When Octagon data is available (look for octagon_report in polymarket_search results — it contains outcome_probabilities with per-market model_probability and market_probability), you MUST show a SINGLE unified table. Match each market ticker to its Octagon outcome by market_ticker field, then show:
  | Market | Market % | Model | Edge | Vol |
  |--------|----------|-------|------|-----|
  | Tesla above $330 | 72% | 95% | +23% | 67.5K |
  | Tesla above $340 | 65% | 65% | 0% | 92.1K |
  Market = YES price as %. Model = model_probability from octagon outcome_probabilities. Edge = Model - Market.
  NEVER show a table without Model and Edge columns when Octagon data is present. NEVER show Octagon data in a separate section — it must be in the same table as market data

## Behavior

${behaviorBullets}

## Response Format

${formatBullets}${tablesSection}`;
}

// ============================================================================
// User Prompts
// ============================================================================

/**
 * Build user prompt for agent iteration with full tool results.
 * Anthropic-style: full results in context for accurate decision-making.
 *
 * @param originalQuery - The user's original query
 * @param fullToolResults - Formatted full tool results
 * @param toolUsageStatus - Optional tool usage status for graceful exit mechanism
 */
export function buildIterationPrompt(
  originalQuery: string,
  fullToolResults: string,
  toolUsageStatus?: string | null
): string {
  let prompt = `Query: ${originalQuery}`;

  if (fullToolResults.trim()) {
    prompt += `\n\nData retrieved from tool calls:\n${fullToolResults}`;
  }

  if (toolUsageStatus) {
    prompt += `\n\n${toolUsageStatus}`;
  }

  prompt += `\n\nContinue working toward answering the query. When you have gathered sufficient data to answer, write your complete answer directly and do not call more tools. NEVER guess at URLs - use ONLY URLs visible in tool results.`;

  return prompt;
}
