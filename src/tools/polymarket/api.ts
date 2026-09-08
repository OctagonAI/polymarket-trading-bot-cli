import { logger } from '../../utils/logger.js';
import { auditTrail } from '../../audit/index.js';
import { dlqWriter } from './dlq.js';

/**
 * Polymarket splits across three services. All reads below are public — no
 * credentials. Trading (CLOB writes) needs EIP-712 signing and lands later.
 *
 *   gamma — market/event/series/tag metadata
 *   clob  — order book, price history, tradeability
 *   data  — wallet positions, trades, portfolio value
 */
export type PolymarketService = 'gamma' | 'clob' | 'data';

const PROD_BASE_URLS: Record<PolymarketService, string> = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  data: 'https://data-api.polymarket.com',
};

const STAGING_BASE_URLS: Record<PolymarketService, string> = {
  gamma: 'https://gamma-api-staging.polymarket.com',
  clob: 'https://clob-staging.polymarket.com',
  data: 'https://data-api-staging.polymarket.com',
};

/**
 * Per-service override wins, then the staging switch, then production.
 *
 * Note: the staging hosts are documented by Polymarket but did not resolve in
 * DNS at the time of writing. Treat POLYMARKET_USE_STAGING as unverified until
 * someone confirms it against real credentials.
 */
function getBaseUrl(service: PolymarketService): string {
  const override = process.env[`POLYMARKET_${service.toUpperCase()}_URL`];
  if (override) return override.replace(/\/$/, '');
  const useStaging = process.env.POLYMARKET_USE_STAGING === 'true';
  return (useStaging ? STAGING_BASE_URLS : PROD_BASE_URLS)[service];
}

// --- Error class ---

export class PolymarketApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly service?: PolymarketService
  ) {
    super(`Polymarket API error: ${statusCode} ${statusText}${body ? ` — ${body}` : ''}`);
    this.name = 'PolymarketApiError';
  }
}

// --- Price helpers ---

/**
 * Snap a price to the market's tick grid and clamp into [0, 1].
 * Polymarket ticks are 0.01 or 0.001, so naive float math leaves values like
 * 0.30000000000000004 that the CLOB rejects.
 */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
  const snapped = Math.round(price / tickSize) * tickSize;
  return Number(Math.min(1, Math.max(0, snapped)).toFixed(decimals));
}

/**
 * Gamma encodes several array fields as JSON *strings*, e.g.
 * `outcomes: "[\"Yes\", \"No\"]"`. Accepts either form and never throws.
 */
export function parseGammaJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Coerce Gamma's stringified numerics ("13084289.42") to a number. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

// --- Retry logic ---

interface RetryContext {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 120_000;
const JITTER_FACTOR = 0.2;

function isRetryable(error: unknown): boolean {
  if (!(error instanceof PolymarketApiError)) return false;
  if (error.statusCode === 429) return true;
  if (error.statusCode >= 500) return true;
  return false;
}

function computeDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = base * JITTER_FACTOR * (2 * Math.random() - 1);
  return Math.max(0, base + jitter);
}

async function withRetry<T>(fn: () => Promise<T>, context: RetryContext): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        if (attempt > 0 && error instanceof PolymarketApiError) {
          // Exhausted retries — write to DLQ
          dlqWriter.append({
            method: context.method,
            path: context.path,
            body: context.body,
            error: error.message,
            attempts: attempt + 1,
          });
          auditTrail.log({
            type: 'DLQ_ENTRY',
            method: context.method,
            path: context.path,
            error: error.message,
            attempts: attempt + 1,
          });
        }
        throw error;
      }

      const apiError = error as PolymarketApiError;
      const delay = computeDelay(attempt);

      auditTrail.log({
        type: 'API_RETRY',
        method: context.method,
        path: context.path,
        attempt: attempt + 1,
        max_retries: MAX_RETRIES,
        status_code: apiError.statusCode,
        delay_ms: Math.round(delay),
      });

      logger.warn(
        `[Polymarket API] ${apiError.statusCode} on ${context.method} ${context.path}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

// --- Public API ---

export interface PolymarketApiResponse {
  [key: string]: unknown;
}

export type ApiParams = Record<string, string | number | boolean | string[] | undefined>;

/**
 * Single HTTP chokepoint for every Polymarket service. Reads need no auth, so
 * unlike the Kalshi client there is no request signing here.
 *
 * Returns `unknown` because Gamma endpoints return bare arrays while CLOB and
 * Data return objects; callers narrow via the typed helpers in this directory.
 */
export async function callPolymarketApi<T = unknown>(
  service: PolymarketService,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options?: { params?: ApiParams; body?: Record<string, unknown> }
): Promise<T> {
  return withRetry(
    async () => {
      const url = new URL(`${getBaseUrl(service)}${path}`);
      if (options?.params) {
        for (const [key, value] of Object.entries(options.params)) {
          if (value === undefined || value === null) continue;
          if (Array.isArray(value)) {
            value.forEach((v) => url.searchParams.append(key, String(v)));
          } else {
            url.searchParams.append(key, String(value));
          }
        }
      }

      const fetchOptions: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (options?.body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(options.body);
      }

      const response = await fetch(url.toString(), fetchOptions);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new PolymarketApiError(response.status, response.statusText, text, service);
      }
      if (response.status === 204) return {} as T;

      return (await response.json()) as T;
    },
    { method, path, body: options?.body }
  );
}

/**
 * Page through a Gamma collection. Gamma uses limit/offset and returns a bare
 * array, ending when a short page comes back.
 */
export async function fetchAllGammaPages<T>(
  path: string,
  params: ApiParams,
  pageSize = 100,
  maxPages = 10,
  onProgress?: (info: { fetchedItems: number; page: number; maxPages: number }) => void
): Promise<T[]> {
  const results: T[] = [];

  for (let page = 0; page < maxPages; page++) {
    const batch = await callPolymarketApi<T[]>('gamma', 'GET', path, {
      params: { ...params, limit: pageSize, offset: page * pageSize },
    });
    if (!Array.isArray(batch) || batch.length === 0) break;

    results.push(...batch);
    onProgress?.({ fetchedItems: results.length, page: page + 1, maxPages });
    if (batch.length < pageSize) break;
  }

  return results;
}

/**
 * Page through a CLOB collection. CLOB uses an opaque `next_cursor` and marks
 * the end with the sentinel "LTE=" (base64 for "end").
 */
export async function fetchAllClobPages<T>(
  path: string,
  params: ApiParams,
  maxPages = 10,
  onProgress?: (info: { fetchedItems: number; page: number; maxPages: number }) => void
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const response = await callPolymarketApi<{ data?: T[]; next_cursor?: string }>(
      'clob',
      'GET',
      path,
      { params: cursor ? { ...params, next_cursor: cursor } : params }
    );

    const data = response?.data;
    if (!Array.isArray(data) || data.length === 0) break;

    results.push(...data);
    onProgress?.({ fetchedItems: results.length, page: page + 1, maxPages });

    cursor = response.next_cursor;
    if (!cursor || cursor === 'LTE=') break;
  }

  return results;
}
