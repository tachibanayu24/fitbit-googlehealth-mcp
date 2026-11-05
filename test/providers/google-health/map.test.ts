import { describe, expect, it } from 'vitest';
import {
  durationMs,
  fromCivilDate,
  fromCivilDateTime,
  GOOGLE_TO_MEAL_TYPE_ID,
  MEAL_TYPE_TO_GOOGLE,
  NUTRIENT,
  nameToNumericId,
  num,
  pointDate,
  pointTimestamp,
  SLEEP_STAGE_TO_LEVEL,
} from '../../../src/providers/google-health/map';

describe('num', () => {
  it('parses the int64-as-string values the API returns', () => {
    // Every int64 field arrives quoted: {"count": "1250"}.
    expect(num('1250')).toBe(1250);
    expect(num(1250)).toBe(1250);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(num(undefined)).toBeUndefined();
    expect(num(null)).toBeUndefined();
    expect(num('')).toBeUndefined();
    expect(num('not-a-number')).toBeUndefined();
  });

  it('preserves zero rather than treating it as missing', () => {
    expect(num('0')).toBe(0);
    expect(num(0)).toBe(0);
  });
});

describe('fromCivilDate', () => {
  it('zero-pads month and day', () => {
    expect(fromCivilDate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
  });

  it('returns undefined when any component is missing', () => {
    expect(fromCivilDate({ year: 2026, month: 1 })).toBeUndefined();
    expect(fromCivilDate(undefined)).toBeUndefined();
    expect(fromCivilDate('2026-01-05')).toBeUndefined();
  });
});

describe('fromCivilDateTime', () => {
  it('combines date and time parts', () => {
    expect(
      fromCivilDateTime({
        date: { year: 2026, month: 9, day: 10 },
        time: { hours: 7, minutes: 5 },
      }),
    ).toBe('2026-09-10T07:05:00');
  });

  it('falls back to the date alone when no time is present', () => {
    expect(fromCivilDateTime({ date: { year: 2026, month: 9, day: 10 } })).toBe('2026-09-10');
  });
});

describe('pointDate', () => {
  it('prefers the civil interval start, so a reading lands on the local day', () => {
    expect(
      pointDate({
        interval: {
          civilStartTime: { date: { year: 2026, month: 9, day: 10 } },
          startTime: '2026-09-09T23:00:00Z',
        },
      }),
    ).toBe('2026-09-10');
  });

  it('falls back to the physical instant when no civil time is present', () => {
    expect(pointDate({ interval: { startTime: '2026-09-09T23:00:00Z' } })).toBe('2026-09-09');
  });

  it('reads sample-time points', () => {
    expect(
      pointDate({ sampleTime: { civilTime: { date: { year: 2026, month: 9, day: 1 } } } }),
    ).toBe('2026-09-01');
  });

  it('reads daily-summary points, which carry a bare date', () => {
    expect(pointDate({ date: { year: 2026, month: 9, day: 2 } })).toBe('2026-09-02');
  });
});

describe('pointTimestamp', () => {
  it('returns a full local timestamp for sample points', () => {
    expect(
      pointTimestamp({
        sampleTime: {
          civilTime: { date: { year: 2026, month: 9, day: 10 }, time: { hours: 6, minutes: 30 } },
        },
      }),
    ).toBe('2026-09-10T06:30:00');
  });
});

describe('durationMs', () => {
  it('parses the API second-suffixed duration format', () => {
    expect(durationMs('3600s')).toBe(3_600_000);
    expect(durationMs('90s')).toBe(90_000);
  });

  it('handles fractional seconds and bare numbers', () => {
    expect(durationMs('1.5s')).toBe(1500);
    expect(durationMs(2)).toBe(2000);
  });

  it('returns undefined for junk', () => {
    expect(durationMs(undefined)).toBeUndefined();
    expect(durationMs('abc')).toBeUndefined();
  });
});

describe('nameToNumericId', () => {
  it('is stable for the same resource name', () => {
    const n = 'users/me/dataTypes/weight/dataPoints/abc123';
    expect(nameToNumericId(n)).toBe(nameToNumericId(n));
  });

  it('distinguishes different resource names', () => {
    expect(nameToNumericId('users/me/dataTypes/weight/dataPoints/a')).not.toBe(
      nameToNumericId('users/me/dataTypes/weight/dataPoints/b'),
    );
  });

  it('is always a non-negative integer, since the tool schema expects one', () => {
    for (const s of ['a', 'zzzzzzzzzzzzzzzzzzzz', 'users/me/x/y/z-9', '~!@#$%^&*()']) {
      const id = nameToNumericId(s);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns 0 for a missing name', () => {
    expect(nameToNumericId(undefined)).toBe(0);
    expect(nameToNumericId('')).toBe(0);
  });
});

describe('meal type mapping', () => {
  it('round-trips every meal slot to a distinct API enum value', () => {
    const values = Object.values(MEAL_TYPE_TO_GOOGLE);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps morning and afternoon snacks distinguishable', () => {
    expect(MEAL_TYPE_TO_GOOGLE.MorningSnack).not.toBe(MEAL_TYPE_TO_GOOGLE.AfternoonSnack);
  });

  it('maps every emitted enum back to a numeric meal type id', () => {
    for (const g of Object.values(MEAL_TYPE_TO_GOOGLE)) {
      expect(GOOGLE_TO_MEAL_TYPE_ID[g]).toBeDefined();
    }
  });

  it('uses only enum values the v4 discovery document defines', () => {
    const valid = new Set([
      'MEAL_TYPE_UNSPECIFIED',
      'BEFORE_BREAKFAST',
      'BREAKFAST',
      'BEFORE_LUNCH',
      'LUNCH',
      'BEFORE_DINNER',
      'DINNER',
      'AFTER_DINNER',
      'SNACK',
      'ANYTIME',
    ]);
    for (const g of Object.values(MEAL_TYPE_TO_GOOGLE)) {
      expect(valid.has(g)).toBe(true);
    }
  });
});

describe('nutrient enum names', () => {
  it('uses only names the v4 discovery document defines', () => {
    // Notably SUGAR, singular — SUGARS is silently dropped by the API.
    const valid = new Set(['PROTEIN', 'DIETARY_FIBER', 'SODIUM', 'SUGAR']);
    for (const n of Object.values(NUTRIENT)) {
      expect(valid.has(n)).toBe(true);
    }
  });
});

describe('sleep stage mapping', () => {
  it('covers every stage the API can emit', () => {
    for (const stage of ['AWAKE', 'LIGHT', 'DEEP', 'REM', 'ASLEEP', 'RESTLESS']) {
      expect(SLEEP_STAGE_TO_LEVEL[stage]).toBeDefined();
    }
  });
});
