const SUBCOMMANDS = [
  // Core 6 commands
  'search', 'portfolio', 'analyze', 'watch',
  'buy', 'sell', 'orders', 'help',
  // Legacy aliases (kept for backward compat)
  'edge',
  'alerts', 'config', 'clear-cache', 'chat', 'init', 'status',
  // Backtest
  'backtest',
  // Octagon market search
  'similar',
  // Octagon events
  'events', 'catalysts',
  // Trader Trust scorecard
  'trust',
  // Full markdown report viewer
  'report',
  // Wallet management
  'wallet',
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
  subcommand: Subcommand;
  positionalArgs: string[];
  json: boolean;
  theme?: string;
  ticker?: string;
  interval?: number;
  since?: string;
  minConfidence?: string;
  minEdge?: number;
  live: boolean;
  refresh: boolean;
  report: boolean;
  dryRun: boolean;
  verbose: boolean;
  performance: boolean;
  // Backtest-specific
  resolved: boolean;
  unresolved: boolean;
  days?: number;
  maxAge?: number;
  category?: string;
  limit?: number;
  exportPath?: string;
  /** Backtest universe source — 'api' (default) or 'local'. */
  backtestUniverse?: 'api' | 'local';
  /** Backtest fee model — 'none' (default), 'taker', or 'maker'. */
  backtestFees?: 'none' | 'taker' | 'maker';
  minVolume?: number;
  minPrice?: number;
  maxPrice?: number;
  // Octagon Kalshi search/clusters/basket flags
  topK?: number;
  closeBefore?: string;
  seriesTicker?: string;
  seriesPrefix?: string;
  sortBy?: string;
  tickers?: string;
  query?: string;
  activeOnly: boolean;
  daysToClose?: number;    // ergonomic shortcut: close_before = now + N days
  /** --market <ticker>: drill into a specific market within an event (trust). */
  market?: string;
  /** --force: overwrite an existing wallet instead of refusing. */
  force: boolean;
  /** --yes: skip an interactive confirmation. Scripting only. */
  yes: boolean;
  /** --all: include grants that trading does not require. */
  all: boolean;
  parseErrors: string[];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const positionalArgs: string[] = [];
  let json = false;
  let theme: string | undefined;
  let ticker: string | undefined;
  let interval: number | undefined;
  let since: string | undefined;
  let minConfidence: string | undefined;
  let minEdge: number | undefined;
  let live = false;
  let force = false;
  let yes = false;
  let all = false;
  let refresh = false;
  let report = false;
  const parseErrors: string[] = [];
  let dryRun = false;
  let verbose = false;
  let performance = false;
  let resolved = false;
  let unresolved = false;
  let days: number | undefined;
  let category: string | undefined;
  let limit: number | undefined;
  let exportPath: string | undefined;
  let backtestUniverse: 'api' | 'local' | undefined;
  let backtestFees: 'none' | 'taker' | 'maker' | undefined;
  let maxAge: number | undefined;
  let minVolume: number | undefined;
  let minPrice: number | undefined;
  let maxPrice: number | undefined;
  // Octagon Kalshi flags
  let topK: number | undefined;
  let closeBefore: string | undefined;
  let seriesTicker: string | undefined;
  let seriesPrefix: string | undefined;
  let sortBy: string | undefined;
  let tickers: string | undefined;
  let query: string | undefined;
  let activeOnly = false;
  let daysToClose: number | undefined;
  let market: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--json') {
      json = true;
    } else if (arg === '--theme') {
      const val = argv[++i];
      if (val != null) {
        theme = val;
      } else {
        parseErrors.push('--theme requires a value');
      }
    } else if (arg === '--ticker') {
      const val = argv[++i];
      if (val != null) {
        ticker = val;
      } else {
        parseErrors.push('--ticker requires a value');
      }
    } else if (arg === '--interval') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) {
          interval = numeric;
        } else {
          parseErrors.push(`Invalid --interval value: "${raw}" (expected a positive number)`);
        }
      } else {
        parseErrors.push('--interval requires a value');
      }
    } else if (arg === '--since') {
      const val = argv[++i];
      if (val != null) {
        since = val;
      } else {
        parseErrors.push('--since requires a value');
      }
    } else if (arg === '--min-confidence') {
      const val = argv[++i];
      if (val != null) {
        minConfidence = val.toLowerCase();
      } else {
        parseErrors.push('--min-confidence requires a value');
      }
    } else if (arg === '--min-edge') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw.replace('%', ''));
        if (Number.isFinite(numeric)) {
          minEdge = numeric / 100;
        } else {
          parseErrors.push(`Invalid --min-edge value: "${raw}" (expected a number like 5 or 5%)`);
        }
      } else {
        parseErrors.push('--min-edge requires a value (e.g., --min-edge 5 or --min-edge 5%)');
      }
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--live') {
      live = true;
    } else if (arg === '--refresh') {
      refresh = true;
    } else if (arg === '--report') {
      report = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--performance') {
      performance = true;
    } else if (arg === '--resolved') {
      resolved = true;
    } else if (arg === '--unresolved') {
      unresolved = true;
    } else if (arg === '--category') {
      const val = argv[++i];
      if (val != null) { category = val; } else { parseErrors.push('--category requires a value'); }
    } else if (arg === '--days') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) { days = numeric; }
        else { parseErrors.push(`Invalid --days value: "${raw}" (expected a positive number)`); }
      } else { parseErrors.push('--days requires a value'); }
    } else if (arg === '--limit') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) { limit = numeric; }
        else { parseErrors.push(`Invalid --limit value: "${raw}" (expected a positive number)`); }
      } else { parseErrors.push('--limit requires a value'); }
    } else if (arg === '--export') {
      const val = argv[++i];
      if (val != null) { exportPath = val; } else { parseErrors.push('--export requires a value'); }
    } else if (arg === '--universe') {
      if (i + 1 >= argv.length) {
        parseErrors.push('--universe requires a value (expected "api" or "local")');
      } else {
        const val = argv[++i];
        if (val === 'api' || val === 'local') { backtestUniverse = val; }
        else { parseErrors.push(`Invalid --universe value: "${val}" (expected "api" or "local")`); }
      }
    } else if (arg === '--fees') {
      if (i + 1 >= argv.length) {
        parseErrors.push('--fees requires a value (expected "none", "taker", or "maker")');
      } else {
        const val = argv[++i];
        if (val === 'none' || val === 'taker' || val === 'maker') { backtestFees = val; }
        else { parseErrors.push(`Invalid --fees value: "${val}" (expected "none", "taker", or "maker")`); }
      }
    } else if (arg === '--max-age') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) { maxAge = numeric; }
        else { parseErrors.push(`Invalid --max-age value: "${raw}" (expected a positive number)`); }
      } else { parseErrors.push('--max-age requires a value'); }
    } else if (arg === '--min-volume') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric >= 0) { minVolume = numeric; }
        else { parseErrors.push(`Invalid --min-volume value: "${raw}" (expected a non-negative number)`); }
      } else { parseErrors.push('--min-volume requires a value'); }
    } else if (arg === '--min-price') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) { minPrice = numeric; }
        else { parseErrors.push(`Invalid --min-price value: "${raw}" (expected 0-100)`); }
      } else { parseErrors.push('--min-price requires a value'); }
    } else if (arg === '--max-price') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) { maxPrice = numeric; }
        else { parseErrors.push(`Invalid --max-price value: "${raw}" (expected 0-100)`); }
      } else { parseErrors.push('--max-price requires a value'); }
    } else if (arg === '--top-k') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric > 0) { topK = numeric; }
        else { parseErrors.push(`Invalid --top-k value: "${raw}" (expected a positive integer)`); }
      } else { parseErrors.push('--top-k requires a value'); }
    } else if (arg === '--close-before') {
      const val = argv[++i];
      if (val != null) { closeBefore = val; } else { parseErrors.push('--close-before requires a value'); }
    } else if (arg === '--series') {
      const val = argv[++i];
      if (val != null) { seriesTicker = val; } else { parseErrors.push('--series requires a value'); }
    } else if (arg === '--series-prefix') {
      const val = argv[++i];
      if (val != null) { seriesPrefix = val.toUpperCase(); } else { parseErrors.push('--series-prefix requires a value'); }
    } else if (arg === '--sort-by') {
      const val = argv[++i];
      if (val == null) {
        parseErrors.push('--sort-by requires a value');
      } else {
        // Union across both consumers (search edge + search). Each consumer
        // additionally filters to its own subset; this guards against typos at
        // the CLI surface so invalid values don't silently fall through to defaults.
        const VALID_SORT_BY = new Set([
          // search edge (markets-with-edge)
          'edge_pp', 'expected_return', 'total_volume', 'model_probability',
          // search (markets)
          'volume_24h', 'close_time', 'last_price',
        ]);
        if (VALID_SORT_BY.has(val)) {
          sortBy = val;
        } else {
          parseErrors.push(`Invalid --sort-by value: "${val}" (expected one of ${Array.from(VALID_SORT_BY).join(', ')})`);
        }
      }
    } else if (arg === '--tickers') {
      const val = argv[++i];
      if (val != null) { tickers = val; } else { parseErrors.push('--tickers requires a value (comma-separated list)'); }
    } else if (arg === '-q' || arg === '--query') {
      const val = argv[++i];
      if (val != null) { query = val; } else { parseErrors.push(`${arg} requires a value`); }
    } else if (arg === '--active-only') {
      activeOnly = true;
    } else if (arg === '--market') {
      if (i + 1 >= argv.length) {
        parseErrors.push('--market requires a value (a Polymarket market slug)');
      } else {
        market = argv[++i].toUpperCase();
      }
    } else if (arg === '--days-to-close' || arg === '--max-dte') {
      const raw = argv[++i];
      if (raw != null) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric > 0) { daysToClose = numeric; }
        else { parseErrors.push(`Invalid ${arg} value: "${raw}" (expected a positive integer)`); }
      } else { parseErrors.push(`${arg} requires a value`); }
    } else if (arg.startsWith('--')) {
      parseErrors.push(`Unknown flag: ${arg}`);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (resolved && unresolved) {
    parseErrors.push('Cannot use --resolved and --unresolved together');
  }

  const first = positionalArgs.shift();
  const subcommand: Subcommand =
    first && (SUBCOMMANDS as readonly string[]).includes(first)
      ? (first as Subcommand)
      : 'chat';

  // If first arg wasn't a known subcommand, put it back as a positional
  if (first && !(SUBCOMMANDS as readonly string[]).includes(first)) {
    positionalArgs.unshift(first);
  }

  return {
    subcommand, positionalArgs, json, theme, ticker, interval, since, minConfidence, minEdge,
    live, refresh, report, dryRun, verbose, performance, resolved, unresolved, days, maxAge, category,
    limit, exportPath, backtestUniverse, backtestFees, minVolume, minPrice, maxPrice,
    topK, closeBefore, seriesTicker, sortBy, tickers, query, activeOnly,
    seriesPrefix, daysToClose, market,
    force, yes, all,
    parseErrors,
  };
}
