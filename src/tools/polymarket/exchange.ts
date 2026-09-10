import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callPolymarketApi } from './api.js';
import { formatToolResult } from '../types.js';
import type { PolymarketExchangeStatus } from './types.js';

/**
 * Polymarket has no exchange-hours concept — the CLOB runs continuously — so
 * "status" is a reachability check against the CLOB health endpoint.
 */
export async function fetchExchangeStatus(): Promise<PolymarketExchangeStatus> {
  try {
    await callPolymarketApi('clob', 'GET', '/ok');
    return { exchange_active: true, trading_active: true };
  } catch {
    return { exchange_active: false, trading_active: false };
  }
}

export const getExchangeStatus = new DynamicStructuredTool({
  name: 'get_exchange_status',
  description: 'Check whether the Polymarket CLOB is reachable. Polymarket trades 24/7.',
  schema: z.object({}),
  func: async () => formatToolResult(await fetchExchangeStatus()),
});
