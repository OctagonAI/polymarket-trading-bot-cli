import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi, num, type ApiParams } from './api.js';
import { formatToolResult } from '../types.js';
import type { PolymarketSeries } from './types.js';

type GammaSeries = Record<string, unknown>;

export function normalizeGammaSeries(raw: GammaSeries): PolymarketSeries {
  return {
    ticker: String(raw.slug ?? raw.ticker ?? ''),
    title: String(raw.title ?? ''),
    category: String(raw.seriesType ?? ''),
    frequency: String(raw.recurrence ?? ''),
    tags: [],
    volume_24h: num(raw.volume24hr),
  };
}

export async function fetchSeries(
  q: { slugs?: string[]; closed?: boolean; limit?: number } = {}
): Promise<PolymarketSeries[]> {
  const params: ApiParams = { limit: q.limit ?? 100 };
  if (q.slugs?.length) params.slug = q.slugs;
  if (q.closed !== undefined) params.closed = q.closed;

  const raw = await callPolymarketApi<GammaSeries[]>('gamma', 'GET', '/series', { params });
  return (Array.isArray(raw) ? raw : []).map(normalizeGammaSeries);
}

export async function fetchSeriesBySlug(slug: string): Promise<PolymarketSeries | undefined> {
  const series = await fetchSeries({ slugs: [slug], limit: 1 });
  return series[0];
}

export const getSeries = new DynamicStructuredTool({
  name: 'get_series',
  description: 'Get a Polymarket series (a recurring group of events, e.g. "nfl") by slug.',
  schema: z.object({
    series_ticker: z.string().describe('Series slug, e.g. nfl'),
  }),
  func: async (input) => {
    const series = await fetchSeriesBySlug(input.series_ticker);
    return formatToolResult(series ? { series } : { error: `No series found for "${input.series_ticker}"` });
  },
});
