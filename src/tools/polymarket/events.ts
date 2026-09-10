import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi, fetchAllGammaPages, num, type ApiParams } from './api.js';
import { formatToolResult } from '../types.js';
import { normalizeGammaMarket } from './markets.js';
import type { PolymarketEvent } from './types.js';

type GammaEvent = Record<string, unknown>;

/** Gamma tags are objects ({id,label,slug}); we keep the human labels. */
function tagLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === 'string' ? t : String((t as Record<string, unknown>)?.label ?? '')))
    .filter(Boolean);
}

export function normalizeGammaEvent(raw: GammaEvent): PolymarketEvent {
  const tags = tagLabels(raw.tags);
  const category = tags[0] ?? '';
  const nestedMarkets = Array.isArray(raw.markets) ? (raw.markets as Record<string, unknown>[]) : [];

  return {
    event_ticker: String(raw.slug ?? raw.ticker ?? ''),
    series_ticker: undefined,
    title: String(raw.title ?? ''),
    sub_title: String(raw.description ?? '').slice(0, 200),
    // Polymarket calls this neg-risk: outcome prices across the event sum to 1.
    mutually_exclusive: raw.negRisk === true || raw.enableNegRisk === true,
    category,
    tags,
    close_time: String(raw.endDate ?? ''),
    strike_date: String(raw.endDate ?? ''),
    volume: num(raw.volume),
    volume_24h: num(raw.volume24hr),
    liquidity: num(raw.liquidity),
    markets: nestedMarkets.map((m) => normalizeGammaMarket(m, category)),
  };
}

export interface EventQuery {
  slugs?: string[];
  closed?: boolean;
  active?: boolean;
  tag_slug?: string;
  limit?: number;
  order?: string;
  ascending?: boolean;
}

function toParams(q: EventQuery): ApiParams {
  const params: ApiParams = {};
  if (q.slugs?.length) params.slug = q.slugs;
  if (q.closed !== undefined) params.closed = q.closed;
  if (q.active !== undefined) params.active = q.active;
  if (q.tag_slug) params.tag_slug = q.tag_slug;
  if (q.limit) params.limit = q.limit;
  if (q.order) params.order = q.order;
  if (q.ascending !== undefined) params.ascending = q.ascending;
  return params;
}

export async function fetchEvents(q: EventQuery = {}): Promise<PolymarketEvent[]> {
  const raw = await callPolymarketApi<GammaEvent[]>('gamma', 'GET', '/events', {
    params: { limit: 100, ...toParams(q) },
  });
  return (Array.isArray(raw) ? raw : []).map(normalizeGammaEvent);
}

export async function fetchAllEvents(
  q: EventQuery = {},
  maxPages = 10,
  onProgress?: (info: { fetchedItems: number; page: number; maxPages: number }) => void
): Promise<PolymarketEvent[]> {
  const raw = await fetchAllGammaPages<GammaEvent>('/events', toParams(q), 100, maxPages, onProgress);
  return raw.map(normalizeGammaEvent);
}

export async function fetchEventBySlug(slug: string): Promise<PolymarketEvent | undefined> {
  const events = await fetchEvents({ slugs: [slug], limit: 1 });
  return events[0];
}

export const getEvents = new DynamicStructuredTool({
  name: 'get_events',
  description: 'List Polymarket events (an event groups related markets, e.g. "World Cup Winner").',
  schema: z.object({
    status: z.enum(['open', 'closed']).optional().describe('Event status filter'),
    tag: z.string().optional().describe('Filter by tag slug, e.g. "politics"'),
    limit: z.number().optional().describe('Max events to return (default 50)'),
  }),
  func: async (input) => {
    const events = await fetchEvents({
      closed: input.status ? input.status === 'closed' : undefined,
      tag_slug: input.tag,
      limit: input.limit ?? 50,
      order: 'volume24hr',
      ascending: false,
    });
    return formatToolResult({ events: events.map(({ markets, ...e }) => ({ ...e, market_count: markets?.length ?? 0 })) });
  },
});

export const getEvent = new DynamicStructuredTool({
  name: 'get_event',
  description: 'Get one Polymarket event by slug, including every market in it and their prices.',
  schema: z.object({
    event_ticker: z.string().describe('Event slug, e.g. world-cup-winner'),
  }),
  func: async (input) => {
    const event = await fetchEventBySlug(input.event_ticker);
    return formatToolResult(event ? { event } : { error: `No event found for "${input.event_ticker}"` });
  },
});

/**
 * Keyword search over events.
 *
 * Gamma's /events endpoint has no keyword filter and — importantly — silently
 * ignores unknown query params rather than erroring, so a guessed `title=`/
 * `search=` filter returns unfiltered results that look plausible. /public-search
 * is the only real full-text endpoint; it nests markets and tags like /events.
 */
export async function searchEvents(query: string, limit = 20): Promise<PolymarketEvent[]> {
  const raw = await callPolymarketApi<{ events?: GammaEvent[] }>('gamma', 'GET', '/public-search', {
    params: { q: query, limit_per_type: limit, events_status: 'active' },
  });
  return (raw?.events ?? []).map(normalizeGammaEvent);
}

export const searchEventsTool = new DynamicStructuredTool({
  name: 'search_events',
  description:
    'Full-text search Polymarket events by keyword. This is the ONLY keyword search — /events cannot filter by title. Returns events with their markets and live prices.',
  schema: z.object({
    query: z.string().describe('Search keywords, e.g. "bitcoin" or "fed rate"'),
    limit: z.number().optional().describe('Max events to return (default 20)'),
  }),
  func: async (input) => {
    const events = await searchEvents(input.query, input.limit ?? 20);
    return formatToolResult({ events });
  },
});
