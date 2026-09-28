import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { resolveOctagonEvent } from '../octagon-events-api.js';

describe('resolveOctagonEvent', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.OCTAGON_API_KEY = 'sk_test';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCTAGON_API_KEY;
  });

  function mockFetch(status: number, body: unknown) {
    const fetchMock = mock(async () => new Response(JSON.stringify(body), { status }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const urlsOf = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));

  test('resolves a pasted polymarket.com URL on /events/{ref}, which takes a slug or a ticker', async () => {
    const fetchMock = mockFetch(200, { event_ticker: 'fed-decision-in-september', slug: 'fed-decision-in-september' });

    const event = await resolveOctagonEvent('https://polymarket.com/event/Fed-Decision-In-September?tid=1');

    expect(event?.event_ticker).toBe('fed-decision-in-september');
    expect(urlsOf(fetchMock)).toEqual(['https://api.octagonai.co/v1/predictions/events/fed-decision-in-september']);
  });

  test('a missing event is one request, not a retry of the same URL', async () => {
    const fetchMock = mockFetch(404, { error: { message: 'Event not found' } });

    expect(await resolveOctagonEvent('no-such-event')).toBeNull();
    expect(urlsOf(fetchMock)).toEqual(['https://api.octagonai.co/v1/predictions/events/no-such-event']);
  });
});
