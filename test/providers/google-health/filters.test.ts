import { afterEach, describe, expect, it } from 'vitest';
import { setTimeZone } from '../../../src/lib/date';
import {
  addDays,
  civilDate,
  maxPageSize,
  rollupRangeCapDays,
} from '../../../src/providers/google-health/client';
import {
  dayRangeFilter,
  filterName,
  filterPath,
  singleDayFilter,
} from '../../../src/providers/google-health/filters';

describe('filterName', () => {
  it('converts kebab-case data type ids to snake_case', () => {
    expect(filterName('daily-resting-heart-rate')).toBe('daily_resting_heart_rate');
    expect(filterName('steps')).toBe('steps');
  });
});

describe('filterPath', () => {
  it('uses civil (zone-less) start time for interval types', () => {
    expect(filterPath('steps', 'interval')).toBe('steps.interval.civil_start_time');
  });

  it('uses physical time for sample types', () => {
    expect(filterPath('weight', 'sample')).toBe('weight.sample_time.physical_time');
  });

  it('uses a bare date field for daily summary types', () => {
    expect(filterPath('daily-vo2-max', 'daily')).toBe('daily_vo2_max.date');
  });

  it('filters sleep on END time, since the API rejects a start-time bound', () => {
    expect(filterPath('sleep', 'interval')).toBe('sleep.interval.civil_end_time');
  });

  it('returns an empty path for types that carry no timestamp', () => {
    expect(filterPath('food', 'none')).toBe('');
  });
});

describe('dayRangeFilter', () => {
  it('treats the caller end date as inclusive by emitting an exclusive next-day bound', () => {
    const f = dayRangeFilter('steps', 'interval', '2026-09-01', '2026-09-03');
    expect(f).toContain('>= "2026-09-01T00:00:00"');
    // 09-03 inclusive means "< 09-04".
    expect(f).toContain('< "2026-09-04T00:00:00"');
  });

  it('omits the Z on civil times — the API rejects a zoned civil literal', () => {
    const f = dayRangeFilter('steps', 'interval', '2026-09-01', '2026-09-01');
    expect(f).not.toContain('Z"');
  });

  it('requires an explicit Z on physical sample times', () => {
    const f = dayRangeFilter('weight', 'sample', '2026-09-01', '2026-09-01');
    expect(f).toBe(
      'weight.sample_time.physical_time >= "2026-09-01T00:00:00Z" AND ' +
        'weight.sample_time.physical_time < "2026-09-02T00:00:00Z"',
    );
  });

  it('uses bare dates for daily types', () => {
    expect(dayRangeFilter('daily-vo2-max', 'daily', '2026-09-01', '2026-09-01')).toBe(
      'daily_vo2_max.date >= "2026-09-01" AND daily_vo2_max.date < "2026-09-02"',
    );
  });

  it('only ever uses the >= and < operators the API supports', () => {
    const f = dayRangeFilter('steps', 'interval', '2026-09-01', '2026-09-02') ?? '';
    expect(f).not.toMatch(/<=|[^<>]>[^=]/);
  });

  it('returns undefined for types with no time field', () => {
    expect(dayRangeFilter('food', 'none', '2026-09-01', '2026-09-02')).toBeUndefined();
  });
});

describe('singleDayFilter', () => {
  it('spans exactly one day', () => {
    expect(singleDayFilter('steps', 'interval', '2026-09-10')).toBe(
      'steps.interval.civil_start_time >= "2026-09-10T00:00:00" AND ' +
        'steps.interval.civil_start_time < "2026-09-11T00:00:00"',
    );
  });
});

describe('addDays', () => {
  it('rolls over month boundaries', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles leap days', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is DST-proof, because the arithmetic stays in UTC', () => {
    // 2026-03-29 is a European DST transition; a local-time implementation
    // would land back on the same day here.
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });
});

describe('civilDate', () => {
  it('nests under `date`, which the API requires', () => {
    expect(civilDate('2026-09-10')).toEqual({ date: { year: 2026, month: 9, day: 10 } });
  });

  it('emits numbers, not zero-padded strings', () => {
    const c = civilDate('2026-01-05');
    expect(c.date.month).toBe(1);
    expect(c.date.day).toBe(5);
  });
});

describe('API limits', () => {
  it('caps the high-resolution types at 14 days and the rest at 90', () => {
    expect(rollupRangeCapDays('heart-rate')).toBe(14);
    expect(rollupRangeCapDays('total-calories')).toBe(14);
    expect(rollupRangeCapDays('steps')).toBe(90);
  });

  it('caps sleep and exercise list pages at 25 rows', () => {
    expect(maxPageSize('sleep')).toBe(25);
    expect(maxPageSize('exercise')).toBe(25);
    expect(maxPageSize('steps')).toBe(10000);
  });
});

describe('sample-type bounds follow the configured timezone', () => {
  afterEach(() => setTimeZone('UTC'));

  it('anchors the window to LOCAL midnight, not UTC midnight', () => {
    // Europe/London is UTC+1 in September, so 10 Sept locally begins at
    // 23:00Z on the 9th. Using UTC midnight would shift the day by an hour
    // and silently drop the first hour of readings.
    setTimeZone('Europe/London');
    const f = dayRangeFilter('weight', 'sample', '2026-09-10', '2026-09-10');
    expect(f).toContain('>= "2026-09-09T23:00:00Z"');
    expect(f).toContain('< "2026-09-10T23:00:00Z"');
  });

  it('handles a zone behind UTC', () => {
    // America/New_York is UTC-4 in September.
    setTimeZone('America/New_York');
    const f = dayRangeFilter('weight', 'sample', '2026-09-10', '2026-09-10');
    expect(f).toContain('>= "2026-09-10T04:00:00Z"');
    expect(f).toContain('< "2026-09-11T04:00:00Z"');
  });

  it('uses plain UTC midnight when the zone is UTC', () => {
    setTimeZone('UTC');
    expect(dayRangeFilter('weight', 'sample', '2026-09-10', '2026-09-10')).toBe(
      'weight.sample_time.physical_time >= "2026-09-10T00:00:00Z" AND ' +
        'weight.sample_time.physical_time < "2026-09-11T00:00:00Z"',
    );
  });

  it('leaves civil-time filters alone — they are already wall-clock', () => {
    setTimeZone('Europe/London');
    const f = dayRangeFilter('steps', 'interval', '2026-09-10', '2026-09-10');
    expect(f).toContain('>= "2026-09-10T00:00:00"');
    expect(f).not.toContain('Z"');
  });
});
