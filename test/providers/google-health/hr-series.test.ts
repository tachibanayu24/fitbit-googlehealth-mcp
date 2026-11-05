import { describe, expect, it } from 'vitest';
import {
  bucketize,
  customZones,
  type HrSample,
  isoLocal,
  isoUtc,
  karvonenZones,
  medianIntervalSec,
  offsetSuffix,
  parseHrRows,
  percentMaxZones,
  sliceByTime,
  summarize,
  timeInZones,
} from '../../../src/providers/google-health/hr-series';

const OFF = 5 * 3_600_000; // Asia/Tashkent, +05:00
const T0 = Date.parse('2026-09-26T06:15:20Z');

function row(iso: string, bpm: number) {
  return {
    heartRate: {
      beatsPerMinute: String(bpm),
      sampleTime: { physicalTime: iso, utcOffset: '18000s' },
    },
  };
}

describe('parseHrRows', () => {
  it('reads physical time as UTC, never the civil time, and sorts oldest first', () => {
    // The API lists newest first.
    const s = parseHrRows([row('2026-09-26T06:15:25Z', 120), row('2026-09-26T06:15:20Z', 118)], 0);
    expect(s.map((x) => x.t)).toEqual([T0, T0 + 5000]);
    expect(s[0]?.off).toBe(OFF);
  });

  it('skips rows without a time or a value', () => {
    const s = parseHrRows([{ heartRate: { beatsPerMinute: '90' } }, { heartRate: {} }], 0);
    expect(s).toEqual([]);
  });
});

describe('time formatting', () => {
  it('formats a UTC instant and its local wall clock without a double offset', () => {
    expect(isoUtc(T0)).toBe('2026-09-26T06:15:20Z');
    expect(isoLocal(T0, OFF)).toBe('2026-09-26T11:15:20+05:00');
  });

  it('formats negative and half-hour offsets', () => {
    expect(offsetSuffix(-4 * 3_600_000)).toBe('-04:00');
    expect(offsetSuffix(5.5 * 3_600_000)).toBe('+05:30');
  });
});

const samples: HrSample[] = [
  { t: T0, bpm: 100, off: OFF },
  { t: T0 + 3000, bpm: 110, off: OFF },
  { t: T0 + 6000, bpm: 120, off: OFF },
  { t: T0 + 70_000, bpm: 150, off: OFF },
];

describe('bucketize', () => {
  it('returns raw points for bucket 0', () => {
    const p = bucketize(samples, 0);
    expect(p).toHaveLength(4);
    expect(p[0]).toEqual({
      time_utc: '2026-09-26T06:15:20Z',
      time_local: '2026-09-26T11:15:20+05:00',
      bpm: 100,
    });
  });

  it('aggregates avg, min, max and count per epoch-aligned bucket', () => {
    const p = bucketize(samples, 60);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({
      time_utc: '2026-09-26T06:15:00Z',
      bpm: 110,
      min: 100,
      max: 120,
      samples: 3,
    });
    expect(p[1]).toMatchObject({ time_utc: '2026-09-26T06:16:00Z', bpm: 150, samples: 1 });
  });
});

describe('summarize', () => {
  it('computes avg, min, max, count and median interval', () => {
    expect(summarize(samples)).toEqual({
      avg: 120,
      min: 100,
      max: 150,
      pointCount: 4,
      medianIntervalSec: 3,
      maxGapSec: 64,
    });
  });

  it('handles an empty list', () => {
    expect(summarize([])).toEqual({ pointCount: 0 });
    expect(medianIntervalSec([])).toBeUndefined();
  });
});

describe('sliceByTime', () => {
  it('keeps samples in [from, to)', () => {
    expect(sliceByTime(samples, T0 + 3000, T0 + 70_000).map((s) => s.bpm)).toEqual([110, 120]);
  });
});

describe('zones', () => {
  it('builds Bevel percent-of-max zones', () => {
    const z = percentMaxZones(187);
    expect(z.map((x) => x.min)).toEqual([0, 94, 113, 131, 150, 169]);
    expect(z[5]?.max).toBe(187);
    // Bevel rounds up: max 188 gives Zone 4 from 151 and Zone 5 from 170.
    expect(
      percentMaxZones(188)
        .slice(4)
        .map((x) => [x.min, x.max]),
    ).toEqual([
      [151, 169],
      [170, 188],
    ]);
  });

  it('builds Fitbit Karvonen zones that end at max heart rate', () => {
    // Max 187 (220 - 33), resting 59: reserve 128 -> 110 / 136 / 168 bpm.
    const z = karvonenZones(187, 59);
    expect(z.map((x) => [x.name, x.min, x.max])).toEqual([
      ['Out of Range', 30, 109],
      ['Fat Burn', 110, 135],
      ['Cardio', 136, 167],
      ['Peak', 168, 187],
    ]);
  });

  it('builds custom zones from lower bounds', () => {
    expect(customZones([{ name: 'Z1', min: 94 }, { min: 151 }, { min: 170 }], 188)).toEqual([
      { name: 'Below Z1', min: 0, max: 93 },
      { name: 'Z1', min: 94, max: 150 },
      { name: 'Zone 2', min: 151, max: 169 },
      { name: 'Zone 3', min: 170, max: 188 },
    ]);
    expect(() => customZones([{ min: 150 }, { min: 150 }], 188)).toThrow(/higher/);
  });

  it('weights time by the gap to the next sample and caps long gaps', () => {
    const zones = percentMaxZones(200); // Zone 1 from 100, Zone 2 from 120, Zone 4 from 160
    const t = timeInZones(samples, zones, T0 + 71_000);
    const byName = Object.fromEntries(t.map((x) => [x.name, x.seconds]));
    // 100 bpm for 3 s and 110 bpm for 3 s -> Zone 1; 120 bpm holds 64 s, capped to 30 s -> Zone 2;
    // 150 bpm holds 1 s until the end -> Zone 3.
    expect(byName['Zone 1']).toBe(6);
    expect(byName['Zone 2']).toBe(30);
    expect(byName['Zone 3']).toBe(1);
    expect(t.find((x) => x.name === 'Zone 2')?.minutes).toBe(0.5);
  });
});
