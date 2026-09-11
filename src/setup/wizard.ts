import { existsSync } from 'fs';
import { config } from 'dotenv';
import { ApiKeyInputComponent, createProviderSelector } from '../components/index.js';
import { VimSelectList } from '../components/select-list.js';
import { selectListTheme, theme } from '../theme.js';
import { checkApiKeyExists, saveApiKeyToEnv, ENV_PATH } from '../utils/env.js';
import { fetchExchangeStatus } from '../tools/polymarket/exchange.js';
import { loadBotConfig, saveBotConfig, setBotSetting } from '../utils/bot-config.js';
import { appPath } from '../utils/paths.js';
import { writeWalletFile, walletExists, walletPath, type StoredWallet } from '../wallet/store.js';
import { resetWalletIdentityCache } from '../wallet/identity.js';
import {
  deriveProxyAddress,
  isAddress,
  isPrivateKey,
  normalizePrivateKey,
} from '../wallet/proxy.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import type { SelectItem } from '@mariozechner/pi-tui';

export type WizardState =
  | 'welcome'
  | 'octagon_api_key'
  | 'llm_provider_select'
  | 'llm_api_key'
  | 'wallet_choice'
  | 'wallet_input'
  | 'wallet_created'
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
  /** Staged like the env keys — written to disk only when the wizard completes. */
  private pendingWallet: StoredWallet | null = null;
  private walletError: string | null = null;
  /** Shown once on the wallet_created screen, then only inside pendingWallet. */
  private generatedKey: string | null = null;
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
    this.pendingWallet = null;
    this.walletError = null;
    this.generatedKey = null;
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
        return 'Step 1/5: Octagon API Key';
      case 'llm_provider_select':
        return 'Step 2/5: LLM Provider';
      case 'llm_api_key':
        return `Step 3/5: ${this.selectedProvider ?? 'LLM'} API Key`;
      case 'wallet_choice':
        return 'Step 4/5: Wallet';
      case 'wallet_input':
        return 'Step 4/5: Wallet — bring your own';
      case 'wallet_created':
        return 'Step 4/5: Wallet — save your key';
      case 'bankroll':
        return 'Step 5/5: Bankroll';
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
      case 'wallet_choice':
        return 'A wallet lets the CLI read your balance and positions, and later place trades.\n'
          + 'Research and market data work without one.\n'
          + 'Use a wallet dedicated to this bot: its key is stored on this machine,\n'
          + 'and whatever that key controls, this CLI controls.';
      case 'wallet_input':
        return 'Paste a private key (64 hex characters) to enable trading,\n'
          + 'or a wallet address (0x + 40 hex) for read-only access.\n'
          + 'An address is the one polymarket.com shows you as your deposit address.';
      case 'wallet_created':
        return 'This is the only time the private key is shown. Copy it somewhere safe.';
      case 'bankroll':
        // Framed as a LIMIT, not as "what you have". Polymarket's collateral is
        // pUSD held on-chain, which this build cannot read yet — so the figure
        // has to be told to us. When balance reads land this becomes a cap on
        // the wallet balance, which keeps the framing true rather than making
        // this text a lie later.
        return this.pendingWallet
          ? 'Leave this empty to size against your wallet balance — that is the\n'
            + 'usual choice now that a wallet is set.\n'
            + 'Set a figure only to cap risk BELOW the balance, which is useful\n'
            + 'if the wallet holds more than you want this bot to trade.\n'
            + 'Change it later with: polymarket config risk.bankroll_usdc <amount>'
          : 'How much should position sizing be allowed to risk?\n'
            + 'With no wallet the balance cannot be read, so this figure is all\n'
            + 'Kelly sizing and the risk gate have. Without it, analyze still\n'
            + 'reports edge and catalysts but skips sizing.\n'
            + 'It is a limit you set, not a deposit. Change it with:\n'
            + 'polymarket config risk.bankroll_usdc <amount>\n'
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
      case 'wallet_input':
      case 'bankroll':
        return 'Enter to confirm · Esc to cancel setup';
      case 'wallet_choice':
        return 'Enter to confirm · Esc to cancel setup';
      case 'wallet_created':
        return 'Enter once you have saved the key';
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
    if (
      (this.wizardState === 'llm_provider_select' || this.wizardState === 'wallet_choice') &&
      this.currentSelector
    ) {
      return this.currentSelector;
    }
    if (this.currentInput) {
      return this.currentInput;
    }
    return null;
  }

  /** Returns extra body lines for states without an interactive component */
  getBodyLines(): string[] {
    if (this.wizardState === 'wallet_choice' || this.wizardState === 'wallet_input') {
      return this.walletError ? ['', theme.error(`  ${this.walletError}`)] : [];
    }
    if (this.wizardState === 'wallet_created') {
      const w = this.pendingWallet;
      if (!w) return [];
      return [
        '',
        `    Signing wallet   ${w.signer}`,
        `    Funding wallet   ${w.address}  ${theme.muted('(deposit pUSD here)')}`,
        '',
        theme.error('    Private key'),
        `    ${this.generatedKey}`,
        '',
        theme.error('    Copy this now. It is shown once and cannot be recovered.'),
        theme.muted(`    On finish it is saved to ${walletPath()} (owner-only).`),
      ];
    }
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
      if (this.pendingWallet) {
        const mode = this.pendingWallet.privateKey ? 'trading' : 'read-only';
        lines.push(theme.success('  OK') + `  Wallet ${this.pendingWallet.address} (${mode})`);
      } else {
        lines.push(theme.muted('  --') + '  No wallet — research and market data only.');
        lines.push(theme.muted('      Set one up later: polymarket wallet create'));
      }
      if (this.pendingBankroll !== null) {
        lines.push(theme.success(`  OK`) + `  Position sizing limit: $${this.pendingBankroll}`);
      } else if (this.pendingWallet) {
        lines.push(theme.success('  OK') + '  Position sizing will use your wallet balance.');
        lines.push(theme.muted('      Cap it lower: polymarket config risk.bankroll_usdc 1000'));
      } else {
        lines.push(
          theme.muted('  --') +
            '  No bankroll — analyze will report edge but skip position sizing.',
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
      case 'wallet_choice': {
        if (!this.currentSelector) {
          const items: SelectItem[] = [
            { value: 'create', label: '1. Create a new dedicated wallet (recommended)' },
            { value: 'import', label: '2. Use a wallet I already have' },
            { value: 'skip', label: '3. Skip — research only, set up later' },
          ];
          const list = new VimSelectList(items, 6, selectListTheme);
          list.onSelect = (item) => this.handleWalletChoice(item.value);
          list.onCancel = () => this.cancel();
          this.currentSelector = list;
        }
        return this.currentSelector;
      }
      case 'wallet_input': {
        if (!this.currentInput) {
          // Masked: this field may receive a private key. An address being
          // masked too is a small cost against echoing a key to the screen.
          const input = new ApiKeyInputComponent(true);
          input.onSubmit = (value) => this.handleWalletInput(value);
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
      if (this.wizardState === 'wallet_created') {
        this.transition('bankroll');
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
    // The wallet goes to its own 0600 file, never through saveApiKeyToEnv:
    // that helper sets no mode, so a signing key would land in a 0644 .env.
    if (this.pendingWallet !== null) {
      try {
        writeWalletFile(this.pendingWallet);
        resetWalletIdentityCache();
      } catch {
        failed.push('wallet.json');
      }
    }
    // Bankroll lives in config.json rather than .env, but it is staged the
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
      this.transition('wallet_choice');
      return;
    }
    if (providerId === 'ollama') {
      // Ollama runs locally — no API key needed, but track the selection
      this.selectedProvider = 'ollama';
      this.transition('wallet_choice');
      return;
    }
    this.selectedProvider = providerId;
    this.transition('llm_api_key');
  }

  private handleLlmApiKeySubmit(value: string | null) {
    if (!value || !value.trim()) {
      // Empty submission — treat as skip
      this.selectedProvider = null;
      this.transition('wallet_choice');
      return;
    }
    if (this.selectedProvider) {
      const envName = this.providerEnvMap[this.selectedProvider];
      if (envName) {
        this.stageEnv(envName, value);
      }
    }
    this.transition('wallet_choice');
  }

  /**
   * The wizard never overwrites an existing wallet. Someone re-running setup to
   * change an LLM key must not lose a funded key as a side effect, and the
   * wizard has nowhere safe to show a backup prompt mid-flow.
   */
  private handleWalletChoice(choice: string) {
    if (choice === 'skip') {
      this.pendingWallet = null;
      this.transition('bankroll');
      return;
    }

    if (walletExists()) {
      this.walletError =
        `A wallet already exists at ${walletPath()} and setup will not replace it. `
        + 'Use `polymarket wallet import <key> --force` if you mean to change it.';
      this.pendingWallet = null;
      this.transition('bankroll');
      return;
    }

    if (choice === 'create') {
      const privateKey = generatePrivateKey();
      const signer = privateKeyToAccount(privateKey).address;
      this.pendingWallet = {
        version: 1,
        type: 'proxy',
        address: deriveProxyAddress(signer),
        signer,
        privateKey,
        createdAt: Math.floor(Date.now() / 1000),
      };
      this.generatedKey = privateKey;
      this.walletError = null;
      this.transition('wallet_created');
      return;
    }

    this.transition('wallet_input');
  }

  /**
   * Accepts either form. A bad value keeps the user on this step rather than
   * silently skipping — a mistyped key that quietly becomes "no wallet" is
   * indistinguishable from having declined one.
   */
  private handleWalletInput(value: string | null) {
    const raw = value?.trim() ?? '';
    if (raw === '') {
      this.pendingWallet = null;
      this.walletError = null;
      this.transition('bankroll');
      return;
    }

    if (isPrivateKey(raw)) {
      const privateKey = normalizePrivateKey(raw);
      const signer = privateKeyToAccount(privateKey).address;
      this.pendingWallet = {
        version: 1,
        type: 'proxy',
        address: deriveProxyAddress(signer),
        signer,
        privateKey,
        createdAt: Math.floor(Date.now() / 1000),
      };
      this.walletError = null;
      this.transition('bankroll');
      return;
    }

    if (isAddress(raw)) {
      // Treated as the funding (proxy) address — that is what a user copies
      // from polymarket.com. Deriving from it would yield an empty account.
      this.pendingWallet = {
        version: 1,
        type: 'proxy',
        address: getAddress(raw),
        createdAt: Math.floor(Date.now() / 1000),
      };
      this.walletError = null;
      this.transition('bankroll');
      return;
    }

    this.walletError =
      'Not a private key or an address. Expected 64 hex characters, or 0x plus 40 hex characters. '
      + 'Leave empty and press Enter to skip.';
    this.currentInput = null;
    this.onChange();
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
