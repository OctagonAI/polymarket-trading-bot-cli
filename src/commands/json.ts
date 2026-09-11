export interface CLIResponse<T> {
  ok: boolean;
  command: string;
  timestamp: string;
  data: T;
  meta?: {
    scan_id?: string;
    theme?: string;
    events_scanned?: number;
    actionable?: number;
    octagon_cache_hits?: number;
    octagon_fresh_reports?: number;
    octagon_credits_used?: number;
    /**
     * Non-fatal problems encountered while building `data`.
     *
     * Previously written by `handlePortfolio` but absent from this type — it
     * only typechecked because object spread skips excess-property checks — and
     * never rendered in human output, so a failed positions query or an
     * unreachable Data API showed up as a healthy, empty account.
     */
    warnings?: string[];
    bankroll?: {
      cash_balance: number;
      portfolio_value: number | null;
      open_exposure: number | null;
      available: number;
      positions_count: number | null;
    };
  };
  error?: { code: string; message: string };
}

export function wrapSuccess<T>(command: string, data: T, meta?: CLIResponse<T>['meta']): CLIResponse<T> {
  return {
    ok: true,
    command,
    timestamp: new Date().toISOString(),
    data,
    ...(meta ? { meta } : {}),
  };
}

export function wrapError(command: string, code: string, message: string): CLIResponse<never> {
  return {
    ok: false,
    command,
    timestamp: new Date().toISOString(),
    data: undefined as never,
    error: { code, message },
  };
}
