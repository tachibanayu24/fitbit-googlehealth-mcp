import { describe, expect, it } from 'vitest';
import type { HrSample } from '../../../src/providers/google-health/hr-series';
import {
  activeToWall,
  analyzeSegments,
  parsePlan,
  pausesFromEvents,
} from '../../../src/providers/google-health/segments';

const T0 = Date.parse('2026-09-26T06:15:00Z');
const MIN = 60_000;

/** One sample every 5 s from `from` to `to` (exclusive), bpm from `bpmAt`. */
function series(from: number, to: number, bpmAt: (t: number) => number): HrSample[] {
  const out: HrSample[] = [];
  for (let t = from; t < to; t += 5000) out.push({ t, bpm: bpmAt(t), off: 5 * 3600_000 });
  return out;
}

describe('parsePlan', () => {
  it('expands groups and numbers the sets', () => {
    const steps = parsePlan('5w 3r [3r 3w]x4 8w 5w');
    expect(steps).toHaveLength(12);
    expect(steps.reduce((s, x) => s + x.durationSec, 0)).toBe(45 * 60);
    expect(steps.slice(2, 4)).toEqual([
      { label: 'r', durationSec: 180, set: 1 },
      { label: 'w', durationSec: 180, set: 1 },
    ]);
    expect(steps[9]).toEqual({ label: 'w', durationSec: 180, set: 4 });
    expect(steps[0]?.set).toBeUndefined();
  });

  it('reads decimals, m:ss, × and nested groups', () => {
    expect(parsePlan('1.5r 1:30w')).toEqual([
      { label: 'r', durationSec: 90 },
      { label: 'w', durationSec: 90 },
    ]);
    expect(parsePlan('[[1r 1w]×2 2w]x2')).toHaveLength(10);
  });

  it('rejects bad plans with an example', () => {
    expect(() => parsePlan('')).toThrow(/Example/);
    expect(() => parsePlan('5w [3r')).toThrow(/\]xN/);
    expect(() => parsePlan('5w 3r]x2')).toThrow(/without/);
    expect(() => parsePlan('5')).toThrow(/cannot read/);
    expect(() => parsePlan('1:75r')).toThrow(/59 seconds/);
    expect(() => parsePlan('[1r]x0')).toThrow(/repeat/);
    expect(() => parsePlan('[1r]x51')).toThrow(/repeat/);
    expect(() => parsePlan('[[1r]x50]x5')).toThrow(/segments/);
  });
});

describe('pauses', () => {
  it('pairs PAUSE with RESUME and skips a pause before STOP', () => {
    const p = pausesFromEvents([
      { type: 'START', t: 0 },
      { type: 'RESUME', t: 30 },
      { type: 'PAUSE', t: 10 },
      { type: 'PAUSE', t: 90 },
      { type: 'STOP', t: 100 },
    ]);
    expect(p).toEqual([[10, 30]]);
  });

  it('maps active time to wall time', () => {
    const pauses: Array<[number, number]> = [[T0 + 10 * MIN, T0 + 13 * MIN]];
    expect(activeToWall(T0, 5 * MIN, pauses)).toBe(T0 + 5 * MIN);
    expect(activeToWall(T0, 10 * MIN, pauses)).toBe(T0 + 10 * MIN);
    expect(activeToWall(T0, 11 * MIN, pauses)).toBe(T0 + 14 * MIN);
  });
});

describe('analyzeSegments', () => {
  const opts = { startMs: T0, offMs: 5 * 3600_000, pauses: [], workLabel: 'r' };

  it('gives peak, avg, min and end per segment and HRR60', () => {
    // 2 min easy at 100, 2 min work rising 120→143, then 110 after.
    const samples = series(T0, T0 + 6 * MIN, (t) =>
      t < T0 + 2 * MIN ? 100 : t < T0 + 4 * MIN ? 120 + (t - T0 - 2 * MIN) / 5000 : 110,
    );
    const r = analyzeSegments(samples, parsePlan('2w 2r 1w'), { ...opts, endMs: T0 + 5 * MIN });
    expect(r.segments.map((s) => [s.label, s.peak, s.min, s.pointCount])).toEqual([
      ['w', 100, 100, 24],
      ['r', 143, 120, 24],
      ['w', 110, 110, 12],
    ]);
    expect(r.segments[1]?.avg).toBe(131.5);
    expect(r.segments[1]?.end).toEqual({ time_local: '2026-09-26T11:18:55+05:00', bpm: 143 });
    expect(r.recovery).toEqual({
      segmentIndex: 2,
      atEnd: { time_local: '2026-09-26T11:18:55+05:00', bpm: 143 },
      after60s: { time_local: '2026-09-26T11:20:00+05:00', bpm: 110 },
      hrr60: 33,
    });
    expect(r.unplannedTailSec).toBe(0);
  });

  it('skips pauses, cuts the last segment and reports the unplanned tail', () => {
    const samples = series(T0, T0 + 10 * MIN, () => 120);
    const pauses: Array<[number, number]> = [[T0 + 1 * MIN, T0 + 3 * MIN]];
    const r = analyzeSegments(samples, parsePlan('2w 5r'), {
      ...opts,
      pauses,
      endMs: T0 + 6 * MIN,
    });
    expect(r.segments[0]?.end_local).toBe('2026-09-26T11:19:00+05:00');
    expect(r.segments[1]).toMatchObject({ cutShort: true, end_local: '2026-09-26T11:21:00+05:00' });

    // Samples in the pause (11:16–11:18) are left out: 1 min before + 1 min after.
    expect(r.segments[0]?.pointCount).toBe(24);

    const tail = analyzeSegments(samples, parsePlan('2w'), { ...opts, endMs: T0 + 3 * MIN });
    expect(tail.unplannedTailSec).toBe(60);
    expect(tail.recovery).toBeUndefined();
  });

  it('starts a segment at the resume when its edge is the pause start, and ignores label case', () => {
    const samples = series(T0, T0 + 10 * MIN, () => 120);
    const pauses: Array<[number, number]> = [[T0 + 2 * MIN, T0 + 3 * MIN]];
    const r = analyzeSegments(samples, parsePlan('2W 2R'), {
      ...opts,
      pauses,
      endMs: T0 + 6 * MIN,
    });
    expect(r.segments[0]?.end_local).toBe('2026-09-26T11:17:00+05:00');
    expect(r.segments[1]).toMatchObject({ work: true, start_local: '2026-09-26T11:18:00+05:00' });
    expect(r.recovery?.segmentIndex).toBe(2);
  });

  it('ignores the part of a pause before the start', () => {
    expect(activeToWall(T0, MIN, [[T0 - MIN, T0 + MIN]])).toBe(T0 + 2 * MIN);
    expect(activeToWall(T0, MIN, [[T0 - 2 * MIN, T0 - MIN]])).toBe(T0 + MIN);
  });
});
