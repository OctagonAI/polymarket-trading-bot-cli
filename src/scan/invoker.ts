import { lookupMarket } from '../tools/polymarket/markets.js';
import { fetchWithDeadline, isAbortError, safeText } from '../utils/http.js';
import { fetchEventBySlug } from '../tools/polymarket/events.js';
import { logger } from '../utils/logger.js';
import type { OctagonInvoker, OctagonVariant } from './types.js';

/**
 * Octagon report access, split across two surfaces for a deliberate reason:
 *
 *  - Reading a cached report  → GET /v1/predictions/reports/polymarket/{slug}
 *    A plain HTTP read. No agent inference, no credits, and it returns the
 *    `versions[]` list so callers can tell "never generated" from "stale".
 *
 *  - Generating a fresh one   → POST /v1/responses (prediction-markets agent)
 *    The REST route for generation (POST /predictions/reports/...) is async: it
 *    returns 202 + a run_id and the caller must poll for completion, which can
 *    take several minutes. The agent holds the connection open until the report
 *    exists, so it stays a single awaited call here. Both write to the same
 *    report store, so a generate-then-read round trip is consistent.
 *
 * Both are keyed by the Polymarket EVENT SLUG (the polymarket.com/event/<slug>
 * segment). Note this is not always Octagon's `event_ticker` — see the header of
 * octagon-events-api.ts.
 */

const VENUE = 'polymarket';

function octagonBaseUrl(): string {
  return process.env.OCTAGON_BASE_URL ?? 'https://api.octagonai.co/v1';
}

function requireApiKey(): string {
  const apiKey = process.env.OCTAGON_API_KEY;
  if (!apiKey) throw new Error('OCTAGON_API_KEY not set. Get one at https://app.octagonai.co');
  return apiKey;
}

/**
 * Resolve CLI input to the Polymarket event slug Octagon keys reports by.
 * Accepts a polymarket.com URL, an event slug, or a market slug/conditionId
 * (resolved to its parent event via Gamma).
 *
 * The event lookup has to come first: an event slug is not a market slug, so
 * resolving through markets alone rejects exactly the identifier that reports
 * are keyed by.
 */
async function resolveEventSlug(input: string): Promise<string> {
  // Only an /event/ URL yields an event slug directly. A /market/ URL yields a
  // MARKET slug, which reports are not keyed by — short-circuiting on it would
  // request /reports/polymarket/<market-slug>, 404, and read as a cache miss.
  // Market slugs fall through to the lookups below, which resolve the parent.
  const eventUrl = input.match(/^https?:\/\/(?:www\.)?polymarket\.com\/event\/([^/?#]+)/i);
  if (eventUrl) return eventUrl[1].toLowerCase();

  const marketUrl = input.match(/^https?:\/\/(?:www\.)?polymarket\.com\/market\/([^/?#]+)/i);
  const candidate = (marketUrl ? marketUrl[1] : input).toLowerCase();

  const event = await fetchEventBySlug(candidate).catch(() => undefined);
  if (event) return (event.event_ticker || candidate).toLowerCase();

  const market = await lookupMarket(candidate);
  if (!market) {
    throw new Error(`'${input}' not found on Polymarket. Use polymarket_search to find valid slugs.`);
  }
  return (market.event_ticker || market.ticker).toLowerCase();
}

/**
 * Extract text content from an OpenAI-compatible responses API result.
 */
function extractTextFromResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data);

  const obj = data as Record<string, unknown>;

  // OpenAI responses format: { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
  if (Array.isArray(obj.output)) {
    for (const item of obj.output) {
      if (item && typeof item === 'object') {
        const entry = item as Record<string, unknown>;
        if (Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block && typeof block === 'object') {
              const b = block as Record<string, unknown>;
              if (b.type === 'output_text' && typeof b.text === 'string') {
                return b.text;
              }
            }
          }
        }
        // Direct text field
        if (typeof entry.text === 'string') return entry.text;
      }
    }
  }

  // Chat completions format: { choices: [{ message: { content: "..." } }] }
  if (Array.isArray(obj.choices)) {
    const first = obj.choices[0] as Record<string, unknown> | undefined;
    if (first?.message && typeof first.message === 'object') {
      const msg = first.message as Record<string, unknown>;
      if (typeof msg.content === 'string') return msg.content;
    }
  }

  // Direct output_text field
  if (typeof obj.output_text === 'string') return obj.output_text;

  // Fallback
  return JSON.stringify(data);
}

interface ReportResponse {
  event_ticker: string;
  venue: string;
  requested_url: string | null;
  versions: unknown[];
  markdown_report: string | null;
  run_id: string | null;
}

/**
 * GET the newest cached report for an event.
 *
 * Returns the raw JSON string OctagonClient.parseReport consumes. The response
 * is re-shaped with a `latest_report` alias because the agent nests the markdown
 * one level deeper, and the parser reads that path; an empty `versions` array is
 * passed through untouched so the parser can flag a cache miss.
 */
async function fetchCachedReport(slug: string): Promise<string> {
  const apiKey = requireApiKey();
  const url = `${octagonBaseUrl()}/predictions/reports/${VENUE}/${encodeURIComponent(slug)}?version=latest`;

  return fetchWithDeadline(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    60_000,
    async (resp) => {
      // No report has ever been generated for this event — a cache miss, not an error.
      if (resp.status === 404) {
        return JSON.stringify({ event_ticker: slug, venue: VENUE, versions: [] });
      }

      if (!resp.ok) {
        const body = await safeText(resp);
        throw new Error(`Octagon reports API ${resp.status} (GET ${VENUE}/${slug}): ${body.slice(0, 200)}`);
      }

      const data = (await resp.json()) as ReportResponse;
      return JSON.stringify({
        ...data,
        latest_report: data.markdown_report
          ? { markdown_report: data.markdown_report, run_id: data.run_id }
          : undefined,
      });
    },
  );
}

/**
 * Generate a fresh report via the prediction-markets agent, which blocks until
 * the run completes. Retries the gateway errors a long-running run tends to hit.
 */
async function generateReport(slug: string, variant: OctagonVariant): Promise<string> {
  const apiKey = requireApiKey();
  const baseUrl = octagonBaseUrl();
  const model = variant === 'default'
    ? 'octagon-prediction-markets-agent'
    : `octagon-prediction-markets-agent:${variant}`;

  // The agent accepts an event slug or a full polymarket.com URL.
  const timeoutMs = 600_000;
  const reqBody = JSON.stringify({ model, input: `https://polymarket.com/event/${slug}` });
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [15_000, 30_000, 60_000]; // 15s, 30s, 60s

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1];
      logger.info(`[octagon] Returned ${lastError?.message?.match(/\d{3}/)?.[0] ?? '5xx'}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      await new Promise((r) => setTimeout(r, delay));
    }

    // The deadline has to outlive the body read, and the body read decides
    // whether to retry — but a callback cannot `continue` the loop, so it
    // reports back instead and the loop acts on that.
    let outcome: { retry: Error } | { text: string };
    try {
      outcome = await fetchWithDeadline(
        `${baseUrl}/responses`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: reqBody,
        },
        timeoutMs,
        async (resp) => {
          if (resp.ok) {
            return { text: extractTextFromResponse(await resp.json()) };
          }

          const body = await safeText(resp);
          const isHtml = body.trimStart().startsWith('<');
          const detail = isHtml ? '' : body.slice(0, 200);

          // Retry on 502/503/504 gateway errors
          if ([502, 503, 504].includes(resp.status) && attempt < MAX_RETRIES) {
            return {
              retry: new Error(`${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`),
            };
          }

          // Non-retryable error or retries exhausted
          const maskedKey = apiKey.length > 4 ? '...' + apiKey.slice(-4) : '****';
          const curl = `curl -X POST '${baseUrl}/responses' \\\n  -H 'Authorization: Bearer ${maskedKey}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${reqBody}'`;
          throw new Error(
            `Octagon API error: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}\n\nReproduce with:\n${curl}`
          );
        },
      );
    } catch (err) {
      if (isAbortError(err)) {
        const secs = Math.round(timeoutMs / 1000);
        throw new Error(
          `Octagon API timed out after ${secs}s. The ${variant} report is taking longer than expected. ` +
          `Try again later or use cached data (omit --refresh).`
        );
      }
      throw err;
    }

    if ('text' in outcome) return outcome.text;
    lastError = outcome.retry;
  }

  // Should not reach here, but satisfy TypeScript
  throw lastError ?? new Error('Octagon API request failed');
}

/**
 * Fetch an Octagon report for a Polymarket market, event slug or event URL.
 * `cache` reads the stored report; any other variant generates a fresh one.
 */
export async function callOctagon(input: string, variant: OctagonVariant): Promise<string> {
  requireApiKey();
  const slug = await resolveEventSlug(input);
  return variant === 'cache' ? fetchCachedReport(slug) : generateReport(slug, variant);
}

/**
 * Factory for the OctagonInvoker used by ScanLoop.
 */
export function createOctagonInvoker(): OctagonInvoker {
  return async (ticker: string, variant: OctagonVariant): Promise<string> => {
    return callOctagon(ticker, variant);
  };
}
