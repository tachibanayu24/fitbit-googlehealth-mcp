import { describe, expect, it } from 'vitest';
import { parseRetryAfter, sleep } from '../../src/lib/rate-limit';

describe('parseRetryAfter', () => {
  it('returns fallback when header is missing', () => {
    expect(parseRetryAfter(null)).toBe(5);
    expect(parseRetryAfter(undefined)).toBe(5);
  });

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('1')).toBe(1);
    expect(parseRetryAfter('7')).toBe(7);
  });

  it('clamps to maxSec', () => {
    expect(parseRetryAfter('3600')).toBe(30);
    expect(parseRetryAfter('100', { maxSec: 10 })).toBe(10);
  });

  it('treats non-numeric (HTTP-date) as fallback', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(5);
  });

  it('floors to at least 1 second', () => {
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter('0.3')).toBe(1);
  });

  it('honours a custom fallback', () => {
    expect(parseRetryAfter(null, { fallbackSec: 2 })).toBe(2);
  });
});

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(18);
  });
});
