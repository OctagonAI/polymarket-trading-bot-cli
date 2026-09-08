import { callKalshiApi } from '../tools/kalshi/api.js';
import { PROVIDERS } from '../providers.js';
import { getDefaultModelForProvider } from '../utils/model.js';

/**
 * Verify setup: check API keys, exchange connectivity, and optional services.
 * Designed to be the first command a new user runs after `cp env.example .env`.
 */
export async function handleStatus(): Promise<string> {
  const lines: string[] = [];
  let allGood = true;

  lines.push('Checking setup...');
  lines.push('');

  // 1. Exchange API key
  const hasExchangeKey = !!process.env.POLYMARKET_API_KEY;
  const hasExchangePem = !!(process.env.POLYMARKET_PRIVATE_KEY_FILE || process.env.POLYMARKET_PRIVATE_KEY);
  lines.push(hasExchangeKey ? '✓ POLYMARKET_API_KEY set' : '✗ POLYMARKET_API_KEY missing');
  lines.push(hasExchangePem ? '✓ Exchange private key configured' : '✗ Exchange private key missing (set POLYMARKET_PRIVATE_KEY_FILE or POLYMARKET_PRIVATE_KEY)');
  if (!hasExchangeKey || !hasExchangePem) allGood = false;

  // 2. Exchange connectivity
  if (hasExchangeKey && hasExchangePem) {
    try {
      const data = await callKalshiApi('GET', '/exchange/status');
      const active = (data as any).exchange_active;
      const trading = (data as any).trading_active;
      lines.push(active ? '✓ Exchange reachable' : '✗ Exchange not active');
      lines.push(trading ? '✓ Trading enabled' : '⚠ Trading paused');
      if (!active) allGood = false;
    } catch (e: any) {
      lines.push(`✗ Cannot reach Kalshi API: ${e.message}`);
      allGood = false;
    }
  }

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
  lines.push(hasOctagon ? '✓ OCTAGON_API_KEY set' : '⚠ OCTAGON_API_KEY missing — /scan and deep research will not work');

  // 5. Optional: Tavily
  const hasTavily = !!process.env.TAVILY_API_KEY;
  lines.push(hasTavily ? '✓ TAVILY_API_KEY set (web search enabled)' : '  TAVILY_API_KEY not set (web search disabled — optional)');

  // 6. Demo mode
  if (process.env.POLYMARKET_USE_DEMO === 'true') {
    lines.push('⚠ POLYMARKET_USE_DEMO=true — using demo environment (no real money)');
  }

  lines.push('');
  lines.push(allGood ? '✓ All good — ready to trade.' : '✗ Fix the issues above before continuing.');

  return lines.join('\n');
}
