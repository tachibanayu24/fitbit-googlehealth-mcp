import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, planNight } from '../../src/insights/schedule';
import { nightsByDate } from '../../src/insights/sleep';
import type { Day, SleepNight } from '../../src/insights/types';
import {
  efficiencyScore,
  heartStress,
  recoveryBand,
  sleepConsistency,
  sleepNeed,
  sleepPerformance,
  sleepPlanner,
  strainLoad,
  strainNeedMin,
  strainTarget,
  stressMonitor,
  whoopDays,
  whoopHrMax,
  whoopRhr,
  whoopStrain,
  withDetail,
  zoneMinutes,
} from '../../src/insights/whoop';
import { bucketsFromMinutes, hrvNight } from '../../src/insights/whoop-report';

const MIN = 60_000;
const base = Date.UTC(2026, 9, 11, 14, 0);

const sleep = (fromMin: number, asleep: number, extra: Partial<SleepNight> = {}): SleepNight => ({
  bedtime: '00:30',
  wake: '06:00',
  startMs: base + fromMin * MIN,
  endMs: base + (fromMin + asleep + 10) * MIN,
  bedMinute: (1440 + 30 + fromMin) % 1440,
  wakeMinute: (30 + fromMin + asleep + 10) % 1440,
  asleep,
  inBed: asleep + 10,
  awake: 10,
  wakeUps: 5,
  deep: Math.round(asleep * 0.15),
  rem: Math.round(asleep * 0.2),
  light: Math.round(asleep * 0.65),
  naps: 0,
  napMin: 0,
  ...extra,
});

describe('nightsByDate', () => {
  it('joins a sleep logged soon after waking into the same night', () => {
    const main = sleep(0, 254);
    const back = sleep(254 + 10 + 39, 91);
    const night = nightsByDate([
      { date: '2026-10-12', main: false, night: back },
      { date: '2026-10-12', main: true, night: main },
    ]).get('2026-10-12');
    expect(night).toMatchObject({
      asleep: 345,
      startMs: main.startMs,
      endMs: back.endMs,
      joined: 1,
    });
    expect(night?.awake).toBe(10 + 10 + 39);
    expect(night?.naps).toBe(0);
  });

  it('keeps an afternoon nap separate and counts its minutes', () => {
    const night = nightsByDate([
      { date: '2026-10-12', main: true, night: sleep(0, 420) },
      { date: '2026-10-12', main: false, night: sleep(780, 25) },
    ]).get('2026-10-12');
    expect(night).toMatchObject({ asleep: 420, naps: 1, napMin: 25 });
  });

  it('finishes the night with a sleep before noon, without counting the time up as in bed', () => {
    const main = sleep(0, 258);
    const back = sleep(268 + 118, 30);
    const night = nightsByDate([
      { date: '2026-10-13', main: true, night: main },
      { date: '2026-10-13', main: false, night: back },
    ]).get('2026-10-13');
    expect(night).toMatchObject({ asleep: 288, inBed: 308, awake: 20, endMs: back.endMs });
    expect(night).toMatchObject({ joined: 1, naps: 0, napMin: 0 });
  });

  it('keeps a sleep three hours after waking, or after noon, as a nap', () => {
    const far = nightsByDate([
      { date: '2026-10-13', main: true, night: sleep(0, 258) },
      { date: '2026-10-13', main: false, night: sleep(268 + 200, 30) },
    ]).get('2026-10-13');
    expect(far).toMatchObject({ asleep: 258, naps: 1, napMin: 30 });
    const afternoon = nightsByDate([
      { date: '2026-10-13', main: true, night: sleep(180, 420) },
      { date: '2026-10-13', main: false, night: sleep(180 + 430 + 100, 40) },
    ]).get('2026-10-13');
    expect(afternoon).toMatchObject({ asleep: 420, naps: 1, napMin: 40 });
  });

  it('starts the next night with an evening sleep up to three hours before it, time up not in bed', () => {
    const evening = sleep(1163, 221, { bedtime: '19:53', wake: '23:44' });
    const main = sleep(1566, 200, { bedtime: '02:36', wake: '06:06' });
    const nights = nightsByDate([
      { date: '2026-10-12', main: true, night: sleep(0, 252) },
      { date: '2026-10-12', main: false, night: evening },
      { date: '2026-10-13', main: true, night: main },
    ]);
    expect(nights.get('2026-10-12')).toMatchObject({ asleep: 252, naps: 0, napMin: 0 });
    expect(nights.get('2026-10-13')).toMatchObject({
      asleep: 421,
      inBed: 441,
      awake: 20,
      bedtime: '19:53',
      wake: '06:06',
      startMs: evening.startMs,
      endMs: main.endMs,
      joined: 1,
      naps: 0,
    });
  });

  it('joins an evening sleep within 90 minutes of the night, gap counted in bed', () => {
    const evening = sleep(1230, 140);
    const main = sleep(1440, 330);
    const night = nightsByDate([
      { date: '2026-10-12', main: false, night: evening },
      { date: '2026-10-13', main: true, night: main },
    ]).get('2026-10-13');
    expect(night).toMatchObject({ asleep: 470, inBed: 150 + 60 + 340, joined: 1 });
  });

  it('keeps an evening sleep far from the night, or an afternoon nap, where it is', () => {
    const far = nightsByDate([
      { date: '2026-10-12', main: true, night: sleep(0, 252) },
      { date: '2026-10-12', main: false, night: sleep(1163, 221) },
      { date: '2026-10-13', main: true, night: sleep(1163 + 231 + 200, 200) },
    ]);
    expect(far.get('2026-10-12')).toMatchObject({ asleep: 252, naps: 1, napMin: 221 });
    expect(far.get('2026-10-13')).toMatchObject({ asleep: 200, naps: 0 });
    const afternoon = nightsByDate([
      { date: '2026-10-12', main: true, night: sleep(0, 252) },
      { date: '2026-10-12', main: false, night: sleep(810, 60) },
      { date: '2026-10-13', main: true, night: sleep(810 + 70 + 120, 400) },
    ]);
    expect(afternoon.get('2026-10-12')).toMatchObject({ naps: 1, napMin: 60 });
    expect(afternoon.get('2026-10-13')).toMatchObject({ asleep: 400, naps: 0 });
  });

  it('ignores an overlapping copy and a lone short nap', () => {
    const nights = nightsByDate([
      { date: '2026-10-12', main: true, night: sleep(0, 400) },
      { date: '2026-10-12', main: false, night: sleep(60, 100) },
      { date: '2026-10-13', main: false, night: sleep(1500, 40) },
    ]);
    expect(nights.get('2026-10-12')).toMatchObject({ asleep: 400, naps: 0 });
    expect(nights.has('2026-10-13')).toBe(false);
  });
});

describe('whoop resting heart rate', () => {
  it('uses heart rate during sleep like Whoop, falling back to the daily figure', () => {
    expect(whoopRhr({ date: 'd', exercises: [], rhr: 79, sleepHr: 69 } as Day)).toBe(69);
    expect(whoopRhr({ date: 'd', exercises: [], rhr: 79 } as Day)).toBe(79);
  });
});

describe('whoop sleep', () => {
  it("uses Whoop's patented strain term, 37 minutes after a strain of 15", () => {
    expect(strainNeedMin(15)).toBe(37);
    expect(sleepNeed(undefined, 0, 0).needMin).toBe(450);
    expect(sleepNeed(15, 60, 30)).toMatchObject({
      needMin: 517,
      need: { baseline: 450, strain: 37, debt: 60, naps: 30 },
    });
  });

  it('is led by hours against need, with Whoop bands', () => {
    expect(sleepPerformance(100, 95, 90)).toBeGreaterThanOrEqual(85);
    expect(sleepPerformance(64)).toBe(64);
    expect(efficiencyScore(90)).toBe(100);
    expect(efficiencyScore(80)).toBe(70);
  });

  it('needs 3 nights before scoring consistency', () => {
    const night = sleep(0, 420);
    expect(sleepConsistency([night, night], night)).toBe(100);
    expect(sleepConsistency([night], night)).toBeUndefined();
    expect(sleepConsistency([sleep(240, 420), sleep(240, 420)], night)).toBeLessThan(50);
  });

  it('carries half of a short night into the next need', () => {
    const days: Day[] = [
      { date: '2026-10-11', exercises: [], sleep: sleep(0, 300), hrv: 40 },
      { date: '2026-10-12', exercises: [], sleep: sleep(0, 450), hrv: 40 },
    ];
    const [first, second] = whoopDays(days, [undefined, undefined]);
    expect(first?.debtAfter).toBe(75);
    expect(second?.sleep.needMin).toBe(525);
  });
});

describe('whoop recovery', () => {
  const steady = (n: number, last: Partial<Day>): Day[] => [
    ...Array.from({ length: n }, (_, k) => ({
      date: `2026-10-${String(k + 1).padStart(2, '0')}`,
      exercises: [],
      sleep: sleep(0, 460),
      hrv: 45 + (k % 3),
      rhr: 60 + (k % 2),
      breathing: 15,
    })),
    {
      date: `2026-10-${String(n + 1).padStart(2, '0')}`,
      exercises: [],
      sleep: sleep(0, 460),
      ...last,
    },
  ];

  it('waits for one earlier night and greys out the first 4', () => {
    expect(whoopDays(steady(0, { hrv: 45 }), [])[0]?.recovery.score).toBeUndefined();
    expect(whoopDays(steady(2, { hrv: 45, rhr: 60 }), [])[2]?.recovery).toMatchObject({
      calibrating: true,
      nights: 2,
    });
  });

  it('sits near 67% on a night at baseline, as the fitted Whoop model does', () => {
    const r = whoopDays(steady(14, { hrv: 46, rhr: 60.5, breathing: 15 }), [])[14]?.recovery;
    expect(r?.score).toBeGreaterThanOrEqual(62);
    expect(r?.score).toBeLessThanOrEqual(72);
  });

  it('is green with HRV up and red after a rough night', () => {
    const good = whoopDays(steady(10, { hrv: 60, rhr: 55, breathing: 14.6 }), []);
    const bad = whoopDays(
      steady(10, { hrv: 30, rhr: 68, breathing: 16.5, sleep: sleep(0, 250) }),
      [],
    );
    expect(good[10]?.recovery).toMatchObject({ band: 'green', calibrating: false });
    expect(bad[10]?.recovery).toMatchObject({ band: 'red' });
  });

  it('uses the published Whoop colour bands', () => {
    expect([recoveryBand(33), recoveryBand(34), recoveryBand(66), recoveryBand(67)]).toEqual([
      'red',
      'yellow',
      'yellow',
      'green',
    ]);
  });
});

describe('whoop strain', () => {
  const at = (bpm: number, minutes: number, from = 0) =>
    Array.from({ length: minutes }, (_, k) => ({ ms: (from + k) * 60_000, bpm, min: 1 }));

  it('matches the published and fitted calibration points', () => {
    expect(whoopHrMax(27)).toBeCloseTo(186.9, 1);
    const run = [...at(130, 2), ...at(150, 2, 2), ...at(170, 19, 4), ...at(185, 15, 23)];
    expect(whoopStrain(strainLoad(run, 51, 187))).toBeCloseTo(17.2, 0);
    expect(whoopStrain(strainLoad(at(115, 30), 55, 187))).toBeCloseTo(4.8, 0);
    expect(whoopStrain(1e6)).toBeLessThanOrEqual(21);
  });

  it('adds loads, never strains, so a second hard hour adds little', () => {
    const one = whoopStrain(strainLoad(at(160, 60), 55, 187));
    const two = whoopStrain(strainLoad(at(160, 120), 55, 187));
    expect(two - one).toBeLessThan(3);
  });

  it('swaps five-minute points for one-minute workout detail', () => {
    const coarse = [
      { ms: 0, bpm: 120, min: 5 },
      { ms: 300_000, bpm: 80, min: 5 },
    ];
    const merged = withDetail(coarse, [{ from: 0, to: 300_000, points: at(150, 5) }]);
    expect(merged).toHaveLength(6);
  });

  it('sets a lower target on red days', () => {
    expect(strainTarget('red')).toEqual([4, 10]);
    expect(strainTarget(undefined)).toBeUndefined();
  });

  it("counts minutes in Whoop's heart rate reserve zones from 40%", () => {
    const pts = [0.3, 0.45, 0.65, 0.75, 0.85, 0.95].map((r, k) => ({
      ms: k,
      bpm: 60 + r * 100,
      min: 5,
    }));
    expect(zoneMinutes(pts, 60, 160)).toEqual([5, 5, 5, 5, 5]);
  });

  it('plans Peak, Perform and Get by bedtimes from recent efficiency', () => {
    const plan = sleepPlanner(450, planNight(DEFAULT_SCHEDULE, '2026-10-13'), [90, 90, 90]);
    expect(plan.map((p) => p.bedtime)).toEqual(['22:40', '23:55', '01:10']);
  });
});

describe('whoop stress', () => {
  it("matches the patent's example: resting 60, max 190, heart rate 100 gives about 2.1", () => {
    expect(heartStress(100, 60, 190)).toBeCloseTo(2.1, 1);
    expect(heartStress(62, 60, 190)).toBeLessThan(1);
  });

  it('skips sleep and walking, and counts minutes in each band', () => {
    const pts = [65, 70, 120, 100].map((bpm, k) => ({ ms: k * 300_000, bpm, min: 5 }));
    const out = stressMonitor(pts, new Map([[600_000, 400]]), 60, 190, [[0, 300_000]]);
    expect(out.series.map((s) => s.v === null)).toEqual([true, false, true, false]);
    expect(out.calm + out.neutral + out.high).toBe(10);
  });
});

describe('bucketsFromMinutes', () => {
  it('averages one-minute heart rate into the five-minute slots of that day', () => {
    const start = Date.UTC(2026, 9, 22, 13, 30);
    const minutes = [60, 62, 64, 66, 68, 90].map((bpm, k) => ({
      ms: start + k * MIN,
      bpm,
      min: 1,
    }));
    const list = bucketsFromMinutes([{ ms: start - MIN, bpm: 50, min: 1 }, ...minutes], start);
    expect(list).toHaveLength(288);
    expect(list.slice(0, 3)).toEqual([64, 90, null]);
  });
});

describe('hrvNight', () => {
  it("keeps last night's samples and takes the spread from the week before", () => {
    const night = sleep(0, 400);
    const before = Array.from({ length: 40 }, (_, k) => ({
      ms: night.startMs - (k + 1) * 3_600_000,
      rmssd: k % 2 ? 30 : 45,
    }));
    const inside = [{ ms: night.startMs + 10 * MIN, rmssd: 38 }];
    const out = hrvNight([...before, ...inside], night);
    expect(out.samples).toEqual(inside);
    expect(out.lnMean).toBeCloseTo((Math.log(30) + Math.log(45)) / 2, 5);
    expect(out.lnSpread).toBeGreaterThan(0.1);
  });
});
