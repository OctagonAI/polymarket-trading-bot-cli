import { describe, test, expect, afterEach } from 'bun:test';
import { fetchWithDeadline, isAbortError, safeText } from '../http.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * A response whose headers arrive immediately but whose body never completes,
 * wired to the caller's abort signal the way a real fetch would be. This is the
 * shape that used to hang: fetch() resolves, the old code cleared the timeout,
 * and the body read then waited forever.
 */
function stallingBodyFetch(): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        });
        // Otherwise: never enqueue, never close.
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('fetchWithDeadline', () => {
  test('aborts a response whose body stalls after the headers arrive', async () => {
    stallingBodyFetch();

    const started = Date.now();
    const promise = fetchWithDeadline('https://example.test/x', {}, 100, (r) => r.json());

    await expect(promise).rejects.toThrow();
    // The point of the fix: it settles on the deadline rather than never.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('the abort is reported as an abort, so callers can translate it', async () => {
    stallingBodyFetch();

    let caught: unknown;
    try {
      await fetchWithDeadline('https://example.test/x', {}, 100, (r) => r.json());
    } catch (err) {
      caught = err;
    }
    expect(isAbortError(caught)).toBe(true);
  });

  test('passes the signal through and returns what readBody produced', async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('{"value":7}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const out = await fetchWithDeadline(
      'https://example.test/x',
      { method: 'POST', body: '{}' },
      1_000,
      async (r) => ((await r.json()) as { value: number }).value,
    );

    expect(out).toBe(7);
    expect(seen?.signal).toBeDefined();
    expect(seen?.method).toBe('POST');
    // Caller init must survive the signal being injected.
    expect(seen?.body).toBe('{}');
  });

  test("honours the caller's own signal instead of replacing it", async () => {
    // Cancelling mid-flight must still work. Overwriting init.signal with the
    // deadline's silently made caller cancellation a no-op.
    const caller = new AbortController();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            signal?.addEventListener('abort', () => {
              c.error(new DOMException('The operation was aborted.', 'AbortError'));
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    // Generous deadline, so only the caller's abort can end this.
    const promise = fetchWithDeadline(
      'https://example.test/x',
      { signal: caller.signal },
      60_000,
      (r) => r.json(),
    );
    caller.abort();

    await expect(promise).rejects.toThrow();
  });

  test('a caller signal that is already aborted reaches fetch aborted', async () => {
    // Real fetch rejects immediately on a pre-aborted signal, so the stub does
    // too — the part under test is that the caller's aborted state survives
    // being combined with the deadline, rather than being dropped.
    let seenAborted: boolean | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenAborted = init?.signal?.aborted;
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const caller = new AbortController();
    caller.abort();

    await expect(
      fetchWithDeadline('https://example.test/x', { signal: caller.signal }, 60_000, (r) => r.json()),
    ).rejects.toThrow();
    expect(seenAborted).toBe(true);
  });

  test('an error thrown by readBody reaches the caller unchanged', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;

    const promise = fetchWithDeadline('https://example.test/x', {}, 1_000, async (r) => {
      if (!r.ok) throw new Error(`upstream said ${r.status}`);
      return r.json();
    });

    await expect(promise).rejects.toThrow('upstream said 500');
  });
});

describe('isAbortError', () => {
  test('recognises an abort however it was constructed', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    // Not every runtime hands back a DOMException — an instanceof check misses
    // this one and turns a timeout into an unrecognised crash.
    const plain = new Error('x');
    plain.name = 'AbortError';
    expect(isAbortError(plain)).toBe(true);
  });

  test('does not swallow unrelated failures', () => {
    expect(isAbortError(new Error('ECONNRESET'))).toBe(false);
    expect(isAbortError(new TypeError('fetch failed'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});

describe('safeText', () => {
  test('reads a body, and yields empty rather than throwing on a failed read', async () => {
    expect(await safeText(new Response('hello'))).toBe('hello');

    const broken = new Response(
      new ReadableStream({ start(c) { c.error(new Error('connection reset')); } }),
    );
    expect(await safeText(broken)).toBe('');
  });
});
