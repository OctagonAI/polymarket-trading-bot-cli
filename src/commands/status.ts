import { fetchExchangeStatus } from '../tools/polymarket/exchange.js';
import { PROVIDERS } from '../providers.js';
import { getDefaultModelForProvider } from '../utils/model.js';
import { getWalletAddress } from '../tools/polymarket/portfolio.js';

/**
 * Verify setup: check connectivity, API keys, and optional services.
 * Designed to be the first command a new user runs after `cp env.example .env`.
 *
 * Note what is NOT checked: exchange credentials. Polymarket's market data is
 * public, so there is nothing to authenticate for reads — the Kalshi original
 * required an API key plus an RSA key here, which for Polymarket would report a
 * permanent failure for credentials that cannot exist.
 */
export async function handleStatus(): Promise<string> {
  const lines: string[] = [];
  let allGood = true;

  lines.push('Checking setup...');
  lines.push('');

  // 1. Market data — public, so this is a plain reachability check
  const staging = process.env.POLYMARKET_USE_STAGING === 'true';
  try {
    const data = await fetchExchangeStatus();
    if (data.exchange_active) {
      lines.push(`✓ Polymarket CLOB reachable${staging ? ' (staging)' : ''} — no credentials needed for market data`);
    } else {
      lines.push('✗ Polymarket CLOB unreachable');
      allGood = false;
    }
  } catch (e: any) {
    lines.push(`✗ Cannot reach Polymarket: ${e.message}`);
    allGood = false;
  }
  if (staging) {
    lines.push('⚠ POLYMARKET_USE_STAGING=true — staging hosts are unverified and may not resolve');
  }

  // 2. Wallet address — read-only, only needed for portfolio lookups
  const wallet = getWalletAddress();
  lines.push(
    wallet
      ? `✓ POLYMARKET_WALLET_ADDRESS set (${wallet.slice(0, 6)}…${wallet.slice(-4)})`
      : '  POLYMARKET_WALLET_ADDRESS not set — `portfolio` needs it (read-only; optional otherwise)',
  );

  // 3. LLM provider — detect which provider is configured and show its default model
  const configuredProvider = PROVIDERS.find(
    (p) => p.apiKeyEnvVar && process.env[p.apiKeyEnvVar],
  );
  const defaultModel =
    process.env.DEFAULT_MODEL ??
    (configuredProvider ? getDefaultModelForProvider(configuredProvider.id) : undefined);
  const llmKey = !!configuredProvider;
  lines.push(
    llmKey
      ? `✓ LLM provider configured (${configuredProvider!.displayName}${defaultModel ? `, default model: ${defaultModel}` : ''})`
      : '✗ No LLM API key set (need at least one: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)',
  );
  if (!llmKey) allGood = false;

  // 4. Octagon
  const hasOctagon = !!process.env.OCTAGON_API_KEY;
  lines.push(
    hasOctagon
      ? '✓ OCTAGON_API_KEY set'
      : '⚠ OCTAGON_API_KEY missing — deep research and `similar`/`events`/`trust`/`report` will not work',
  );

  // 5. Optional: Tavily
  const hasTavily = !!process.env.TAVILY_API_KEY;
  lines.push(hasTavily ? '✓ TAVILY_API_KEY set (web search enabled)' : '  TAVILY_API_KEY not set (web search disabled — optional)');

  lines.push('');
  lines.push(allGood ? '✓ All good — ready to research.' : '✗ Fix the issues above before continuing.');
  lines.push('  Order placement is not implemented yet; buy/sell/cancel are unavailable.');

  return lines.join('\n');
}
