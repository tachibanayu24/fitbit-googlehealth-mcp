import { describe, expect, it } from 'vitest';
import { assertIsoDate, normalizeRange, todayJst, toJstDateString } from '../../src/lib/date';

describe('toJstDateString', () => {
  it('formats epoch as JST date', () => {
    // 1970-01-01T00:00:00Z → JST: 1970-01-01T09:00:00+09 → "1970-01-01"
    expect(toJstDateString(0)).toBe('1970-01-01');
  });

  it('rolls over to next day once UTC passes 15:00', () => {
    // 2026-04-22T15:00:00Z is 2026-04-23T00:00:00 JST
    expect(toJstDateString('2026-04-22T15:00:00Z')).toBe('2026-04-23');
    expect(toJstDateString('2026-04-22T14:59:59Z')).toBe('2026-04-22');
  });

  it('throws on invalid input', () => {
    expect(() => toJstDateString('not-a-date')).toThrow(RangeError);
  });

  it('todayJst returns a 10-char YYYY-MM-DD', () => {
    const today = todayJst();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('assertIsoDate', () => {
  it.each(['2026-01-01', '2026-12-31', '2024-02-29'])('accepts %s', (v) => {
    expect(() => assertIsoDate(v)).not.toThrow();
  });

  it.each([
    '2026-13-01',
    '2026-00-01',
    '2026-01-32',
    '2026-1-1',
    '2026/01/01',
    '',
    '2026-04-22T00:00:00Z',
  ])('rejects %s', (v) => {
    expect(() => assertIsoDate(v)).toThrow(RangeError);
  });
});

describe('normalizeRange', () => {
  it('returns both dates when start <= end', () => {
    expect(normalizeRange('2026-04-01', '2026-04-22')).toEqual({
      start: '2026-04-01',
      end: '2026-04-22',
    });
    expect(normalizeRange('2026-04-22', '2026-04-22')).toEqual({
      start: '2026-04-22',
      end: '2026-04-22',
    });
  });

  it('throws when start > end', () => {
    expect(() => normalizeRange('2026-04-23', '2026-04-22')).toThrow(/inverted/);
  });

  it('throws when either date is malformed', () => {
    expect(() => normalizeRange('2026-4-1', '2026-04-22')).toThrow(RangeError);
    expect(() => normalizeRange('2026-04-01', 'tomorrow')).toThrow(RangeError);
  });
});
