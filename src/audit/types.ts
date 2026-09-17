import type { ConfidenceLevel } from '../scan/types.js';

export interface AuditBase {
  ts: string; // ISO 8601 UTC
  type: string;
}

export interface ScanStartEvent extends AuditBase {
  type: 'SCAN_START';
  theme: string;
  events_count: number;
}

export interface ScanCompleteEvent extends AuditBase {
  type: 'SCAN_COMPLETE';
  scan_id: string;
  theme: string;
  events_scanned: number;
  edges_found: number;
  duration_ms: number;
}

export interface OctagonCallEvent extends AuditBase {
  type: 'OCTAGON_CALL';
  ticker: string;
  variant: string;
  cache_hit: boolean;
  credits_used: number;
}

export interface EdgeDetectedEvent extends AuditBase {
  type: 'EDGE_DETECTED';
  ticker: string;
  model_prob: number;
  market_prob: number;
  edge: number;
  confidence: ConfidenceLevel;
  drivers: string[];
}

export interface RecommendationEvent extends AuditBase {
  type: 'RECOMMENDATION';
  ticker: string;
  action: string;
  size: number;
  kelly: number;
  risk_gate: string;
}

export interface TradeExecutedEvent extends AuditBase {
  type: 'TRADE_EXECUTED';
  ticker: string;
  order_id: string;
  fill_price: number;
  size: number;
  /** buy or sell. Without it the log cannot tell an entry from an exit. */
  action?: string;
  /** Outcome traded — "Yes", "Team A". Not every market is binary. */
  outcome?: string;
}

export interface AlertSentEvent extends AuditBase {
  type: 'ALERT_SENT';
  alert_id: string;
  channels: string[];
}

export interface WatchdogCheckEvent extends AuditBase {
  type: 'WATCHDOG_CHECK';
  ticker: string;
  entry_edge: number;
  current_edge: number;
  status: string;
}

export interface ApiRetryEvent extends AuditBase {
  type: 'API_RETRY';
  method: string;
  path: string;
  attempt: number;
  max_retries: number;
  status_code: number;
  delay_ms: number;
}

export interface DlqEntryEvent extends AuditBase {
  type: 'DLQ_ENTRY';
  method: string;
  path: string;
  error: string;
  attempts: number;
}

export interface ConfigChangeEvent extends AuditBase {
  type: 'CONFIG_CHANGE';
  category: string;
  avg_brier: number;
  trigger: string;
  recommendation: string;
}

export interface ConfigSetEvent extends AuditBase {
  type: 'CONFIG_SET';
  key: string;
  old_value: string;  // JSON.stringify'd
  new_value: string;  // JSON.stringify'd
}

export interface OctagonErrorEvent extends AuditBase {
  type: 'OCTAGON_ERROR';
  ticker: string;
  event_ticker: string;
  error: string;
}

export type AuditEvent =
  | ScanStartEvent
  | ScanCompleteEvent
  | OctagonCallEvent
  | EdgeDetectedEvent
  | RecommendationEvent
  | TradeExecutedEvent
  | AlertSentEvent
  | WatchdogCheckEvent
  | ApiRetryEvent
  | DlqEntryEvent
  | ConfigChangeEvent
  | ConfigSetEvent
  | OctagonErrorEvent;

export type AuditEventType = AuditEvent['type'];

/**
 * Distributive Omit that preserves discriminated union narrowing.
 * Standard Omit<Union, K> collapses the union; this distributes over each member.
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
