import { afterEach, describe, expect, it } from 'vitest';
import {
  assertIsoDate,
  getTimeZone,
  localDayStartUtc,
  normalizeRange,
  setTimeZone,
  today,
  toLocalDateString,
  toLocalTimeString,
  zoneOffsetMs,
} from '../../src/lib/date';

afterEach(() => setTimeZone('UTC'));

describe('toLocalDateString', () => {
  it('formats an epoch instant in the requested zone', () => {
    // 1970-01-01T00:00:00Z is already 09:00 on the 1st in Tokyo.
    expect(toLocalDateString(0, 'Asia/Tokyo')).toBe('1970-01-01');
    // ...but still 1969-12-31 in New York.
    expect(toLocalDateString(0, 'America/New_York')).toBe('1969-12-31');
    expect(toLocalDateString(0, 'UTC')).toBe('1970-01-01');
  });

  it('rolls the local day over at the zone boundary, not at UTC midnight', () => {
    expect(toLocalDateString('2026-04-22T15:00:00Z', 'Asia/Tokyo')).toBe('2026-04-23');
    expect(toLocalDateString('2026-04-22T14:59:59Z', 'Asia/Tokyo')).toBe('2026-04-22');
  });

  it('respects a zone that is behind UTC', () => {
    // 00:30 UTC is still the previous evening in Los Angeles.
    expect(toLocalDateString('2026-09-10T00:30:00Z', 'America/Los_Angeles')).toBe('2026-09-09');
  });

  it('handles a British Summer Time offset', () => {
    expect(toLocalDateString('2026-06-15T23:30:00Z', 'Europe/London')).toBe('2026-06-16');
    expect(toLocalDateString('2026-01-15T23:30:00Z', 'Europe/London')).toBe('2026-01-15');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    expect(toLocalDateString('2026-04-22T12:00:00Z', 'Not/AZone')).toBe('2026-04-22');
  });

  it('throws on invalid input', () => {
    expect(() => toLocalDateString('not-a-date')).toThrow(RangeError);
  });
});

describe('setTimeZone / today', () => {
  it('defaults to UTC when given nothing', () => {
    setTimeZone(undefined);
    expect(getTimeZone()).toBe('UTC');
    setTimeZone('');
    expect(getTimeZone()).toBe('UTC');
  });

  it('makes today() follow the configured zone', () => {
    setTimeZone('Asia/Tokyo');
    expect(today()).toBe(toLocalDateString(new Date(), 'Asia/Tokyo'));
    setTimeZone('America/New_York');
    expect(today()).toBe(toLocalDateString(new Date(), 'America/New_York'));
  });

  it('returns a 10-char YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

describe('zoneOffsetMs', () => {
  it('reports the summer and winter offsets for a DST zone', () => {
    expect(zoneOffsetMs(new Date('2026-06-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000);
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0);
  });

  it('reports negative offsets for zones behind UTC', () => {
    expect(zoneOffsetMs(new Date('2026-09-10T12:00:00Z'), 'America/New_York')).toBe(-14_400_000);
  });

  it('is zero for UTC and for an unknown zone', () => {
    expect(zoneOffsetMs(new Date('2026-09-10T12:00:00Z'), 'UTC')).toBe(0);
    expect(zoneOffsetMs(new Date('2026-09-10T12:00:00Z'), 'Not/AZone')).toBe(0);
  });
});

describe('localDayStartUtc', () => {
  it('returns the UTC instant at which the local day begins', () => {
    expect(localDayStartUtc('2026-09-10', 'Europe/London').toISOString()).toBe(
      '2026-09-09T23:00:00.000Z',
    );
    expect(localDayStartUtc('2026-01-10', 'Europe/London').toISOString()).toBe(
      '2026-01-10T00:00:00.000Z',
    );
    expect(localDayStartUtc('2026-09-10', 'America/New_York').toISOString()).toBe(
      '2026-09-10T04:00:00.000Z',
    );
  });

  it('lands correctly on a DST transition day', () => {
    // Clocks go forward in the UK on 2026-03-29; the day still starts at 00:00 GMT.
    expect(localDayStartUtc('2026-03-29', 'Europe/London').toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
    // The day after is already BST.
    expect(localDayStartUtc('2026-03-30', 'Europe/London').toISOString()).toBe(
      '2026-03-29T23:00:00.000Z',
    );
  });
});

describe('toLocalTimeString', () => {
  it('renders an instant as local wall-clock', () => {
    expect(toLocalTimeString(Date.parse('2026-09-10T08:30:00Z'), 'Europe/London')).toBe('09:30:00');
    expect(toLocalTimeString(Date.parse('2026-01-10T08:30:00Z'), 'Europe/London')).toBe('08:30:00');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(toLocalTimeString(Date.parse('2026-09-10T08:30:00Z'), 'Not/AZone')).toBe('08:30:00');
  });
});
