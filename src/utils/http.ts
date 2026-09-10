/**
 * One place for the fetch deadline, because getting it wrong is silent.
 *
 * `fetch()` resolves as soon as the response HEADERS arrive — the body is still
 * an unread stream at that point. Clearing the timeout there, which is the
 * obvious reading of "the request finished", leaves the body read unbounded: a
 * connection that dies mid-transfer without a FIN or RST hangs forever, with no
 * error and no output. Measured against Octagon, the body phase is only
 * ~300-450ms of a call whose server compute is 13-32s, so this is a narrow
 * window — but an unbounded one, and every caller here had it.
 *
 * The deadline must therefore cover both phases, which means the body read has
 * to happen inside the same try. Callers pass that read as `readBody`.
 *
 * What is deliberately NOT here: status handling and error types. The four call
 * sites disagree too much to share any — one maps 404 to a cache-miss sentinel,
 * one throws a typed PolymarketApiError, one retries 502/503/504, one attaches a
 * curl repro. Folding those together would need a config object per caller,
 * which is more code than it saves.
 */

/**
 * fetch() whose timeout stays armed until `readBody` has consumed the response.
 *
 * `readBody` receives the raw Response and returns whatever the caller wants —
 * it is the right place to branch on `resp.ok`, read text vs json, and throw.
 * An abort raised while it runs propagates like any other error, so callers that
 * translate AbortError should wrap this whole call rather than just the fetch.
 */
export async function fetchWithDeadline<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  readBody: (resp: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    return await readBody(resp);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when an error came from an aborted request.
 *
 * Checks `name` rather than `instanceof DOMException`: an AbortError can arrive
 * as a plain Error depending on runtime and on whether it crossed a stream
 * boundary, and a missed check turns a timeout into an unrecognised crash.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/** Read a response body as text, treating a failed read as empty. */
export function safeText(resp: Response): Promise<string> {
  return resp.text().catch(() => '');
}
