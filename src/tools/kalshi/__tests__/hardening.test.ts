import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { toDollarString, fromDollarString, KalshiApiError, callKalshiApi } from '../api.js';
import { auditTrail } from '../../../audit/index.js';
import { dlqWriter } from '../dlq.js';

let auditLogSpy: ReturnType<typeof spyOn>;
let dlqAppendSpy: ReturnType<typeof spyOn>;
let originalFetch: typeof globalThis.fetch;
let originalSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  process.env.POLYMARKET_API_KEY = 'test-key';
  process.env.POLYMARKET_PRIVATE_KEY = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCRFVyyjP3KGX63',
    '0/qa6kWsCdNJTbKMBaqTaYzCVKYWr3fA4UcA3Wx9+mXwYQ0+jULQP9Y1qWBpWTmb',
    'vnZaejJaywFK6LESStChcXuqN8uBcF13+CfwxVdbTboAbaHaNsOjHwl6JuYW0Nz+',
    'jOQmN0v/nT/SSq8BOLN7S408VW5yR3sC+W9oJ0qb6gVNJTHazxuEvCjz8k5w+a+D',
    'otAVUg/Y9WVIJqKhIhvQnD2pAN5J20RI4YXfz31GTaKzwMmg/ByoGrtkeJw4StFW',
    'HSVfo2/j9H1EdMTEHyjLyGyXjfiQOTSp/gK0BjaMHGzdltFueCOss8RoQjv2n+2m',
    'OL+aNv7tAgMBAAECggEAEkm0DpmxH/mIvJlO3JotQBtY88OEfxvzvXMvmAtdiDyE',
    'Bt8euSAwHc0jbmJ9beYWhvOVB9ya14y0s0oV1x/SGxm9xvh/4YNmuwL4CKPR1jYY',
    'wheYyUPG2C57BLTNExmWHYi7BBfFJxka0kdmNt7/iHAE7HgXiTrhfOgwHGvUaTki',
    'zDuq/I2rUaG4bDHA8EK19DdFCb2+TuqGYnc7vkMgwz2NajGZNXqOWCJabMVLeQR2',
    'niVRsFo2kY1uXB6Oy+nEixVnTxWRQhT//UWbLr4iJZnlJGpwPGKZZHhNADbx+w+0',
    'ig3iqVnYY11s7cceGTV7C9fGr+H9pERtTp3e1cPmLQKBgQDIP2WoJVz12wUd4ANM',
    'Jz1xpxsYg3txnTST01OidaWxeaDHg/mjzsdKPdMa7eBREJYy4HUllLZrvI9KWp/4',
    'wLCB0aCuytGf6Z2u/bOoTs87HMf13PzC0ksD1Ri9wEECN5NlVnL9NNcnpPE+6gGY',
    '2OzJtzfdr5JwPC5U12IDQVEAWwKBgQC5eiZhZKwHHeQQzJqgURDd3hZJpQdFDcFp',
    'QSH1dNHNdNutTLZ7JakSQcoz9P4Fuu4AEPGCi94xH4NoIq7fPY4ABX0a3vp9guJ+',
    'txChCHusjwVGGcraGSiognyxBnewpt+lzv1xDWBmmGaDqSVayS9eQaEiMypHbaah',
    '2vsiQBWgVwKBgC/EN6qZZwhae2j5869puNVwiB0b2Als94q/oTaim6ivG7Qb/iOe',
    'ApnqD35f+d88dqeiNS+GvtEKRJ/26Cv9Qt1ktNCdHs3ney6v4/gk/HfcULKMSVrr',
    'sOs0HNe+kYNG4IkOyxUtUplpVgas6T6dmDYx10ixRdwx7tdcHUwre3f7AoGARkWP',
    'UQsRWkjq5ap/Uwojt8uy6ggKbxE9HCG/Of4elxcVO916rcGhAvfGIlVKAOXH0mKY',
    '/fr8HeRwpv2s/4uUx1FNCuc8RF1YbuXw+PH72W7+cobHIkax7tYxY+itZFJ1HZ8E',
    'ytZklbpb7LojGvhqZ+25nPmBpTpYDa6nw1xAVVUCgYEAqKcg/QSJIcj+qODjtZZ8',
    'aCqNvagzw74Hruh9jmd3tLvqpzKN72GqdtuzRoGi2BzmjUkrTXhEugf4/AaxfLMy',
    'yk6j0nzHRSVi1GUzx/P/q6gsR8bEvhhBSZEwQxcQDL+1Toamz1nmFXLZo0w3hi6q',
    'wZ0ONbXRO/Hcg1MzeK10biQ=',
    '-----END PRIVATE KEY-----',
  ].join('\n');

  auditLogSpy = spyOn(auditTrail, 'log').mockImplementation(() => {});
  dlqAppendSpy = spyOn(dlqWriter, 'append').mockImplementation(() => {});

  // Save originals
  originalFetch = globalThis.fetch;
  originalSetTimeout = globalThis.setTimeout;

  // Make setTimeout instant for retry tests
  // @ts-expect-error - simplified mock
  globalThis.setTimeout = (fn: () => void, _ms?: number) => {
    fn();
    return 0;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  auditLogSpy.mockRestore();
  dlqAppendSpy.mockRestore();
  delete process.env.POLYMARKET_API_KEY;
  delete process.env.POLYMARKET_PRIVATE_KEY;
});

describe('Dollar conversion', () => {
  it('toDollarString converts cents to dollar string', () => {
    expect(toDollarString(0)).toBe('0.00');
    expect(toDollarString(1)).toBe('0.01');
    expect(toDollarString(58)).toBe('0.58');
    expect(toDollarString(99)).toBe('0.99');
    expect(toDollarString(100)).toBe('1.00');
  });

  it('fromDollarString converts dollar string to cents', () => {
    expect(fromDollarString('0.00')).toBe(0);
    expect(fromDollarString('0.01')).toBe(1);
    expect(fromDollarString('0.58')).toBe(58);
    expect(fromDollarString('0.99')).toBe(99);
    expect(fromDollarString('1.00')).toBe(100);
  });

  it('round-trips correctly for 0-100', () => {
    for (let cents = 0; cents <= 100; cents++) {
      expect(fromDollarString(toDollarString(cents))).toBe(cents);
    }
  });
});

describe('KalshiApiError', () => {
  it('has statusCode, statusText, and body', () => {
    const err = new KalshiApiError(429, 'Too Many Requests', 'rate limited');
    expect(err.statusCode).toBe(429);
    expect(err.statusText).toBe('Too Many Requests');
    expect(err.body).toBe('rate limited');
    expect(err.message).toContain('429');
    expect(err.name).toBe('KalshiApiError');
  });
});

describe('withRetry via callKalshiApi', () => {
  it('retries on 429 then succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await callKalshiApi('GET', '/test');
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(3);
    // Should have logged 2 API_RETRY events
    const retryLogs = auditLogSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'API_RETRY'
    );
    expect(retryLogs.length).toBe(2);
  });

  it('does not retry on 400', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response('bad request', { status: 400, statusText: 'Bad Request' });
    }) as unknown as typeof fetch;

    await expect(callKalshiApi('GET', '/test')).rejects.toThrow(KalshiApiError);
    expect(callCount).toBe(1);
  });

  it('writes to DLQ after exhausting retries', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
    }) as unknown as typeof fetch;

    await expect(callKalshiApi('GET', '/test')).rejects.toThrow(KalshiApiError);
    // 1 initial + 5 retries = 6 calls
    expect(callCount).toBe(6);
    // DLQ should have been written
    expect(dlqAppendSpy).toHaveBeenCalledTimes(1);
    const dlqCall = dlqAppendSpy.mock.calls[0][0] as { method: string; path: string; attempts: number };
    expect(dlqCall.method).toBe('GET');
    expect(dlqCall.path).toBe('/test');
    expect(dlqCall.attempts).toBe(6);
    // DLQ_ENTRY audit event
    const dlqAudit = auditLogSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === 'DLQ_ENTRY'
    );
    expect(dlqAudit.length).toBe(1);
  });

  it('retries on 500 server errors', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('internal error', { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await callKalshiApi('GET', '/test');
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it('does not retry on 401 or 403', async () => {
    for (const status of [401, 403]) {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        return new Response('forbidden', { status, statusText: 'Forbidden' });
      }) as unknown as typeof fetch;

      await expect(callKalshiApi('GET', '/test')).rejects.toThrow(KalshiApiError);
      expect(callCount).toBe(1);
    }
  });
});
