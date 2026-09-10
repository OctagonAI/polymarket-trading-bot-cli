import { existsSync } from 'fs';
import { config } from 'dotenv';
import { ApiKeyInputComponent, createProviderSelector } from '../components/index.js';
import { VimSelectList } from '../components/select-list.js';
import { selectListTheme, theme } from '../theme.js';
import { checkApiKeyExists, saveApiKeyToEnv, ENV_PATH } from '../utils/env.js';
import { fetchExchangeStatus } from '../tools/polymarket/exchange.js';
import { loadBotConfig, saveBotConfig, setBotSetting } from '../utils/bot-config.js';
import { appPath } from '../utils/paths.js';
import type { SelectItem } from '@mariozechner/pi-tui';

export type WizardState =
  | 'welcome'
  | 'octagon_api_key'
  | 'llm_provider_select'
  | 'llm_api_key'
  | 'bankroll'
  | 'testing'
  | 'complete';

interface TestResult {
  name: string;
  status: 'pending' | 'ok' | 'fail' | 'skip';
  message?: string;
}

export class SetupWizardController {
  private wizardState: WizardState = 'welcome';
  private collectedKeys: Record<string, string> = {};
  private originalEnvValues: Record<string, string | undefined> = {};
  private testResults: TestResult[] = [];
  private configWritten = false;
  private selectedProvider: string | null = null;
  /** Staged like the env keys — written only when the user confirms the wizard. */
  private pendingBankroll: string | null = null;
  private bankrollError: string | null = null;
  private readonly onComplete: () => void;
  private readonly onChange: () => void;
  private active = false;

  // Reusable UI components for the current step
  private currentInput: ApiKeyInputComponent | null = null;
  private currentSelector: VimSelectList | null = null;

  constructor(onChange: () => void, onComplete: () => void) {
    this.onChange = onChange;
    this.onComplete = onComplete;
  }

  get state(): WizardState {
    return this.wizardState;
  }

  get isActive(): boolean {
    return this.active;
  }

  start() {
    this.active = true;
    this.wizardState = 'welcome';
    this.collectedKeys = {};
    this.originalEnvValues = {};
    this.testResults = [];
    this.configWritten = false;
    this.selectedProvider = null;
    this.pendingBankroll = null;
    this.bankrollError = null;
    this.currentInput = null;
    this.currentSelector = null;
    this.onChange();
  }

  cancel() {
    this.restoreStagedEnv();
    this.active = false;
    this.wizardState = 'welcome';
    this.currentInput = null;
    this.currentSelector = null;
    this.onChange();
  }

  /** Snapshot and stage an env var — records original value for cancel/restore */
  private stageEnv(key: string, value: string) {
    if (!(key in this.originalEnvValues)) {
      this.originalEnvValues[key] = process.env[key];
    }
    this.collectedKeys[key] = value;
    process.env[key] = value;
  }

  /** Restore all staged env vars to their original values and clear collected keys */
  private restoreStagedEnv() {
    for (const key of Object.keys(this.collectedKeys)) {
      const original = this.originalEnvValues[key];
      if (original !== undefined) {
        process.env[key] = original;
      } else {
        delete process.env[key];
      }
    }
    this.collectedKeys = {};
    this.originalEnvValues = {};
  }

  // --- Rendering info for cli.ts ---

  getTitle(): string {
    switch (this.wizardState) {
      case 'welcome':
        return 'Welcome to Polymarket Trading Bot CLI';
      case 'octagon_api_key':
        return 'Step 1/4: Octagon API Key';
      case 'llm_provider_select':
        return 'Step 2/4: LLM Provider';
      case 'llm_api_key':
        return `Step 3/4: ${this.selectedProvider ?? 'LLM'} API Key`;
      case 'bankroll':
        return 'Step 4/4: Bankroll';
      case 'testing':
        return 'Testing connections...';
      case 'complete':
        return "You're all set!";
    }
  }

  getDescription(): string {
    switch (this.wizardState) {
      case 'welcome':
        return "Let's get you set up. This takes about a minute.\nPolymarket market data needs no credentials — you only need an LLM API key,\nplus an Octagon key if you want deep research.";
      case 'octagon_api_key':
        return 'Paste your Octagon API key (recommended for deep research).\nGet one at: https://app.octagonai.co\nLeave empty and press Enter to skip.';
      case 'llm_provider_select':
        return 'Select your LLM provider. You can change this later with /model.';
      case 'llm_api_key':
        return `Paste your ${this.selectedProvider ?? 'LLM'} API key below.`;
      case 'bankroll':
        // Polymarket has no cash-balance endpoint — free USDC is an on-chain
        // ERC-20 balance, not something the read APIs report — so this number
        // cannot be discovered and has to be told to us.
        return 'How much USDC should position sizing assume you have?\n'
          + 'Used by Kelly sizing and the risk gate; without it, analyze reports\n'
          + 'edge but skips sizing. Not a deposit — just a number, change it any\n'
          + 'time with: polymarket config risk.bankroll_usdc <amount>\n'
          + 'Leave empty and press Enter to skip.';
      case 'testing':
        return '';
      case 'complete':
        return this.configWritten
          ? 'All keys saved to .env. Default thresholds written to config.json.'
          : 'All keys saved to .env. Type /help to get started.';
    }
  }

  getFooter(): string {
    switch (this.wizardState) {
      case 'welcome':
        return 'Enter to continue';
      case 'octagon_api_key':
      case 'llm_api_key':
      case 'bankroll':
        return 'Enter to confirm · Esc to cancel setup';
      case 'llm_provider_select':
        return 'Enter to confirm · Esc to cancel setup';
      case 'testing':
        return '';
      case 'complete':
        if (this.testResults.some((r) => r.status === 'fail')) {
          return 'R to restart wizard · Enter to continue anyway';
        }
        return 'Press Enter to continue';
    }
  }

  /** Returns the component that should receive focus, or null for text-only states */
  getFocusTarget(): ApiKeyInputComponent | VimSelectList | null {
    if (this.wizardState === 'llm_provider_select' && this.currentSelector) {
      return this.currentSelector;
    }
    if (this.currentInput) {
      return this.currentInput;
    }
    return null;
  }

  /** Returns extra body lines for states without an interactive component */
  getBodyLines(): string[] {
    if (this.wizardState === 'bankroll') {
      return this.bankrollError ? ['', theme.error(`  ${this.bankrollError}`)] : [];
    }
    if (this.wizardState === 'testing') {
      return this.testResults.map((r) => {
        const icon =
          r.status === 'ok'   ? theme.success('  OK') :
          r.status === 'fail' ? theme.error('  FAIL') :
          r.status === 'skip' ? theme.muted('  --') :
          theme.muted('  ...');
        const msg = r.message ? theme.muted(` ${r.message}`) : '';
        return `${icon}  ${r.name}${msg}`;
      });
    }
    if (this.wizardState === 'complete') {
      const lines = this.testResults.map((r) => {
        const icon = r.status === 'ok' ? theme.success('  OK') : r.status === 'skip' ? theme.muted('  --') : theme.error('  FAIL');
        const msg = r.message ? theme.muted(` ${r.message}`) : '';
        return `${icon}  ${r.name}${msg}`;
      });
      lines.push('');
      if (this.pendingBankroll !== null) {
        lines.push(theme.success(`  OK`) + `  Bankroll set to $${this.pendingBankroll} USDC`);
      } else {
        lines.push(
          theme.muted('  --') +
            '  Bankroll not set — analyze will report edge but skip position sizing.',
        );
        lines.push(theme.muted('      Set it later: polymarket config risk.bankroll_usdc 1000'));
      }
      if (this.configWritten) {
        lines.push('');
        lines.push(theme.muted('  Default thresholds (to customize, run the command shown):'));
        lines.push(`    min_edge_threshold  = 5%     ${theme.muted('e.g. polymarket config risk.min_edge_threshold 0.10')}`);
        lines.push(`    kelly_multiplier    = 0.5    ${theme.muted('e.g. polymarket config risk.kelly_multiplier 0.25')}`);
        lines.push(`    max_position_pct    = 10%    ${theme.muted('e.g. polymarket config risk.max_position_pct 0.05')}`);
        lines.push(`    daily_loss_limit    = $200   ${theme.muted('e.g. polymarket config risk.daily_loss_limit 100')}`);
        lines.push(`    max_positions       = 10     ${theme.muted('e.g. polymarket config risk.max_positions 5')}`);
        lines.push('');
        lines.push(theme.muted('  Run "polymarket config" to see all settings.'));
      }
      return lines;
    }
    return [];
  }

  /** Create the input/selector component for the current step (called by cli.ts during render) */
  ensureComponent(): ApiKeyInputComponent | VimSelectList | null {
    switch (this.wizardState) {
      case 'octagon_api_key': {
        if (!this.currentInput) {
          const input = new ApiKeyInputComponent(true);
          input.onSubmit = (value) => this.handleOptionalKeySubmit('OCTAGON_API_KEY', value, 'llm_provider_select');
          input.onCancel = () => this.cancel();
          this.currentInput = input;
        }
        return this.currentInput;
      }
      case 'llm_provider_select': {
        if (!this.currentSelector) {
          const items: SelectItem[] = [
            { value: 'openai', label: '1. OpenAI' },
            { value: 'anthropic', label: '2. Anthropic' },
            { value: 'google', label: '3. Google' },
            { value: 'xai', label: '4. xAI' },
            { value: 'deepseek', label: '5. DeepSeek' },
            { value: 'openrouter', label: '6. OpenRouter' },
            { value: 'ollama', label: '7. Ollama (local, no key needed)' },
            { value: 'skip', label: '8. Skip (set up later with /model)' },
          ];
          const list = new VimSelectList(items, 10, selectListTheme);
          list.onSelect = (item) => this.handleProviderSelect(item.value);
          list.onCancel = () => this.cancel();
          this.currentSelector = list;
        }
        return this.currentSelector;
      }
      case 'llm_api_key': {
        if (!this.currentInput) {
          const input = new ApiKeyInputComponent(true);
          input.onSubmit = (value) => this.handleLlmApiKeySubmit(value);
          input.onCancel = () => this.cancel();
          this.currentInput = input;
        }
        return this.currentInput;
      }
      case 'bankroll': {
        if (!this.currentInput) {
          // Unmasked — an amount is not a secret, and echoing it lets the user
          // catch a typo before it silently changes every position size.
          const input = new ApiKeyInputComponent(false);
          input.onSubmit = (value) => this.handleBankrollSubmit(value);
          input.onCancel = () => this.cancel();
          this.currentInput = input;
        }
        return this.currentInput;
      }
      default:
        return null;
    }
  }

  /** Handle keyboard input for non-component states (welcome, testing, complete) */
  handleInput(keyData: string): void {
    if (keyData === '\r') {
      if (this.wizardState === 'welcome') {
        this.transition('octagon_api_key');
        return;
      }
      if (this.wizardState === 'complete') {
        const failed = this.flushKeysToEnv();
        if (failed.length > 0) {
          this.testResults.push(...failed.map((k) => ({ name: `Save ${k}`, status: 'fail' as const, message: 'Failed to write to .env' })));
          this.onChange();
          return;
        }
        this.active = false;
        this.onComplete();
        return;
      }
    }
    if ((keyData === 'r' || keyData === 'R') && this.wizardState === 'complete') {
      if (this.testResults.some((r) => r.status === 'fail')) {
        this.restoreStagedEnv();
        this.testResults = [];
        this.transition('octagon_api_key');
        return;
      }
    }
    if (keyData === '\u001b') {
      // Esc
      if (this.wizardState === 'welcome' || this.wizardState === 'complete') {
        if (this.wizardState === 'complete') {
          const failed = this.flushKeysToEnv();
          if (failed.length > 0) {
            this.testResults.push(...failed.map((k) => ({ name: `Save ${k}`, status: 'fail' as const, message: 'Failed to write to .env' })));
            this.onChange();
            return;
          }
          this.active = false;
          this.onComplete();
        } else {
          this.cancel();
        }
      }
    }
  }

  /** Persist all collected keys to .env — called only when the user confirms completion.
   *  Returns list of keys that failed to persist (empty on full success). */
  private flushKeysToEnv(): string[] {
    const failed: string[] = [];
    for (const [key, value] of Object.entries(this.collectedKeys)) {
      if (!saveApiKeyToEnv(key, value)) {
        failed.push(key);
      }
    }
    // Bankroll lives in settings.json rather than .env, but it is staged the
    // same way: nothing is written unless the user confirms the wizard.
    if (this.pendingBankroll !== null) {
      try {
        setBotSetting('risk.bankroll_usdc', this.pendingBankroll);
      } catch {
        failed.push('risk.bankroll_usdc');
      }
    }
    return failed;
  }

  // --- Internal state transitions ---

  private transition(next: WizardState) {
    this.wizardState = next;
    this.currentInput = null;
    this.currentSelector = null;
    this.onChange();
  }

  private handleOptionalKeySubmit(envName: string, value: string | null, nextState: WizardState) {
    if (value) {
      this.stageEnv(envName, value);
    }
    this.transition(nextState);
  }

  private readonly providerEnvMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
  };

  private handleProviderSelect(providerId: string) {
    if (providerId === 'skip') {
      this.selectedProvider = null;
      this.transition('bankroll');
      return;
    }
    if (providerId === 'ollama') {
      // Ollama runs locally — no API key needed, but track the selection
      this.selectedProvider = 'ollama';
      this.transition('bankroll');
      return;
    }
    this.selectedProvider = providerId;
    this.transition('llm_api_key');
  }

  private handleLlmApiKeySubmit(value: string | null) {
    if (!value || !value.trim()) {
      // Empty submission — treat as skip
      this.selectedProvider = null;
      this.transition('bankroll');
      return;
    }
    if (this.selectedProvider) {
      const envName = this.providerEnvMap[this.selectedProvider];
      if (envName) {
        this.stageEnv(envName, value);
      }
    }
    this.transition('bankroll');
  }

  /**
   * Bankroll is optional: empty skips it, and sizing then reports why rather
   * than guessing. A bad number keeps the user on this step instead of being
   * dropped, because a silently ignored bankroll looks exactly like the "no
   * bankroll configured" state it was meant to fix.
   */
  private handleBankrollSubmit(value: string | null) {
    const raw = value?.trim() ?? '';
    if (raw === '') {
      this.pendingBankroll = null;
      this.bankrollError = null;
      this.startTests();
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.bankrollError = `"${raw}" is not a non-negative number. Enter an amount like 1000, or leave empty to skip.`;
      this.currentInput = null;
      this.onChange();
      return;
    }

    this.pendingBankroll = String(parsed);
    this.bankrollError = null;
    this.startTests();
  }

  private startTests() {
    this.runTests().catch((err) => {
      this.testResults = [{ name: 'Setup error', status: 'fail', message: String(err) }];
      this.wizardState = 'complete';
      this.onChange();
    });
  }

  /** Map provider id → base URL for /models endpoint test */
  private readonly providerBaseUrlMap: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    xai: 'https://api.x.ai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    deepseek: 'https://api.deepseek.com',
  };

  /** Test an API key by hitting a lightweight endpoint */
  private async testBearerKey(baseUrl: string, apiKey: string): Promise<void> {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text.slice(0, 80)}`);
    }
  }

  private async runTests() {
    this.testResults = [
      { name: 'Polymarket CLOB', status: 'pending' },
      { name: 'Octagon API', status: 'pending' },
      { name: 'LLM API', status: 'pending' },
    ];
    this.transition('testing');

    // Reload env from .env (non-overwriting so staged process.env values are preserved)
    config({ path: ENV_PATH, quiet: true });

    // Test Polymarket — public endpoint, no credentials involved.
    // fetchExchangeStatus swallows its own errors and reports the outcome in
    // `exchange_active`, so the flag must be read; a try/catch here would never
    // fire and the wizard would claim "Connected" with the CLOB down.
    try {
      const status = await fetchExchangeStatus();
      this.testResults[0] = status.exchange_active
        ? { name: 'Polymarket CLOB', status: 'ok', message: 'Connected' }
        : { name: 'Polymarket CLOB', status: 'fail', message: 'Unreachable' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.testResults[0] = { name: 'Polymarket CLOB', status: 'fail', message: msg.slice(0, 60) };
    }
    this.onChange();

    // Test Octagon
    const octagonKey = process.env.OCTAGON_API_KEY;
    if (octagonKey) {
      try {
        const octagonBase = process.env.OCTAGON_BASE_URL ?? 'https://api.octagonai.co/v1';
        const res = await fetch(`${octagonBase}/models`, {
          headers: { Authorization: `Bearer ${octagonKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok || res.status === 404) {
          // 404 is fine — key is valid, endpoint just doesn't exist
          this.testResults[1] = { name: 'Octagon API', status: 'ok', message: 'Connected' };
        } else if (res.status === 401 || res.status === 403) {
          this.testResults[1] = { name: 'Octagon API', status: 'fail', message: 'Invalid API key' };
        } else {
          this.testResults[1] = { name: 'Octagon API', status: 'fail', message: `HTTP ${res.status}` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.testResults[1] = { name: 'Octagon API', status: 'fail', message: msg.slice(0, 60) };
      }
    } else {
      this.testResults[1] = { name: 'Octagon API', status: 'skip', message: 'Skipped (set later in .env)' };
    }
    this.onChange();

    // Test LLM
    if (this.selectedProvider === 'ollama') {
      try {
        const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
        const res = await fetch(`${ollamaBase}/api/tags`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          this.testResults[2] = { name: 'LLM API', status: 'ok', message: 'Ollama connected' };
        } else {
          this.testResults[2] = { name: 'LLM API', status: 'fail', message: `Ollama returned ${res.status}` };
        }
      } catch {
        this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Ollama not reachable at localhost:11434' };
      }
    } else if (this.selectedProvider === 'anthropic') {
      // Anthropic doesn't have a /models endpoint — test with a minimal messages call
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: process.env.ANTHROPIC_TEST_MODEL ?? 'claude-haiku-4-5-20251001',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            this.testResults[2] = { name: 'LLM API', status: 'ok', message: 'Anthropic connected' };
          } else if (res.status === 401) {
            this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Invalid API key' };
          } else {
            // 400, 429, etc. still means the key authenticated
            this.testResults[2] = { name: 'LLM API', status: 'ok', message: 'Anthropic key valid' };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.testResults[2] = { name: 'LLM API', status: 'fail', message: msg.slice(0, 60) };
        }
      } else {
        this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Key not found' };
      }
    } else if (this.selectedProvider === 'google') {
      // Google Gemini uses API key as query param
      const apiKey = process.env.GOOGLE_API_KEY;
      if (apiKey) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            this.testResults[2] = { name: 'LLM API', status: 'ok', message: 'Google connected' };
          } else if (res.status === 400 || res.status === 403) {
            this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Invalid API key' };
          } else {
            this.testResults[2] = { name: 'LLM API', status: 'fail', message: `HTTP ${res.status}` };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.testResults[2] = { name: 'LLM API', status: 'fail', message: msg.slice(0, 60) };
        }
      } else {
        this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Key not found' };
      }
    } else if (this.selectedProvider) {
      // OpenAI-compatible providers: openai, xai, openrouter, moonshot, deepseek
      const envName = this.providerEnvMap[this.selectedProvider];
      const apiKey = envName ? process.env[envName] : undefined;
      const baseUrl = this.providerBaseUrlMap[this.selectedProvider];
      if (apiKey && baseUrl) {
        try {
          await this.testBearerKey(baseUrl, apiKey);
          this.testResults[2] = { name: 'LLM API', status: 'ok', message: `${this.selectedProvider} connected` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('401') || msg.includes('403')) {
            this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Invalid API key' };
          } else {
            this.testResults[2] = { name: 'LLM API', status: 'fail', message: msg.slice(0, 60) };
          }
        }
      } else {
        this.testResults[2] = { name: 'LLM API', status: 'fail', message: 'Key not found' };
      }
    } else {
      this.testResults[2] = { name: 'LLM API', status: 'skip', message: 'Skipped (use /model to set up)' };
    }
    this.onChange();

    // Small delay so user can see results
    await new Promise((r) => setTimeout(r, 800));

    // Write default config.json if it doesn't exist yet
    if (!existsSync(appPath('config.json'))) {
      const defaults = loadBotConfig(); // returns DEFAULTS when no file exists
      this.configWritten = saveBotConfig(defaults);
      if (!this.configWritten) {
        this.testResults.push({ name: 'Write config.json', status: 'fail', message: `Could not write to ${appPath('config.json')}` });
      }
    }

    this.wizardState = 'complete';
    this.onChange();
  }
}
