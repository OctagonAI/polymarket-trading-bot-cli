import { afterEach, beforeEach, expect, test } from 'bun:test';
import { callOctagon } from '../invoker';

const realFetch = globalThis.fetch;
const realApiKey = process.env.OCTAGON_API_KEY;
let calls: Array<{ url: string; method: string }> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  process.env.OCTAGON_API_KEY = 'sk_test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realApiKey === undefined) delete process.env.OCTAGON_API_KEY;
  else process.env.OCTAGON_API_KEY = realApiKey;
});

test('refresh generates through the Reports API, not the agent', async () => {
  const slug = 'fed-decision-in-october';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST') return json(202, { run_id: 'run-1', status: 'processing', event_ticker: 'octagon-ticker', venue: 'polymarket' });
    if (url.includes('/status/run-1')) return json(200, { run_id: 'run-1', status: 'completed', venue: 'polymarket', event_ticker: slug, requested_url: null });
    if (url.includes('version=run-1')) {
      return json(200, { event_ticker: slug, venue: 'polymarket', name: null, requested_url: null, versions: [{ run_id: 'run-1' }], markdown_report: '# Fresh', run_id: 'run-1', outcome_probabilities_json: null });
    }
    return json(200, { event_ticker: slug, venue: 'polymarket', name: null, requested_url: null, versions: [], markdown_report: null, run_id: null, outcome_probabilities_json: null });
  }) as typeof fetch;

  // An /event/ URL resolves to the slug without a Gamma lookup. The invoker uses
  // the default 30s poll interval, so this test waits one poll.
  const raw = await callOctagon(`https://polymarket.com/event/${slug}`, 'refresh');
  const parsed = JSON.parse(raw);

  expect(calls.some((c) => c.url.endsWith('/responses'))).toBe(false);
  expect(calls.find((c) => c.method === 'POST')?.url).toContain(`/predictions/reports/polymarket/${slug}`);
  // The pinned run is re-read by slug even though the POST reported another event_ticker.
  expect(calls.find((c) => c.url.includes('version=run-1'))?.url).toContain(`/polymarket/${slug}?`);
  expect(parsed.latest_report).toEqual({ markdown_report: '# Fresh', run_id: 'run-1' });
}, 60_000);
