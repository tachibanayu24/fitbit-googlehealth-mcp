import { describe, expect, it } from 'vitest';
import { bodyAge, meanClock, realAge, sleepProfile, sleepRegularity } from '../../src/insights/age';
import { calibration, guidance, sleepTiming } from '../../src/insights/guidance';
import { DEFAULT_SCHEDULE, planNight } from '../../src/insights/schedule';
import {
  baseline,
  hrvNorm,
  loadBalance,
  readiness,
  type Score,
  sleepScore,
  strainFromTrimp,
  trimp,
} from '../../src/insights/scores';
import type { Day, SleepNight } from '../../src/insights/types';

const DAY_MS = 86_400_000;
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

const night = (asleep: number, date = '2026-10-10', bedMinute = 1380): SleepNight => {
  const startMs = dayStart(date) - DAY_MS + bedMinute * 60_000;
  return {
    bedtime: '23:00',
    wake: '07:00',
    startMs,
    endMs: startMs + (asleep + 20) * 60_000,
    bedMinute,
    wakeMinute: (bedMinute + asleep + 20) % 1440,
    asleep,
    inBed: asleep + 20,
    awake: 20,
    wakeUps: 12,
    deep: Math.round(asleep * 0.18),
    rem: Math.round(asleep * 0.22),
    light: Math.round(asleep * 0.6),
    naps: 0,
    napMin: 0,
  };
};

const date = (i: number) => `2026-10-${String(i + 1).padStart(2, '0')}`;
const day = (d: string, extra: Partial<Day> = {}): Day => ({ date: d, exercises: [], ...extra });

describe('sleepScore', () => {
  it('follows the classic Fitbit split and bands', () => {
    const full = sleepScore(night(480), 55, 60, 0.9);
    expect(full.parts).toEqual({ duration: 50, deepAndRem: 25, restoration: 20 });
    expect(full.label).toBe('Excellent');
    expect(sleepScore(night(300), 70, 68, 0.3).label).toBe('Fair');
  });

  it('puts a 6 hour night in the 70s, as Fitbit users report', () => {
    const score = sleepScore(night(360), 60, 62, 0.6).score;
    expect(score).toBeGreaterThanOrEqual(70);
    expect(score).toBeLessThan(80);
  });
});

describe('readiness', () => {
  const steady = Array.from({ length: 10 }, (_, i) =>
    day(date(i), { hrv: 50 + (i % 3), rhr: 58 + (i % 2), sleep: night(450, date(i)) }),
  );
  const scoresFor = (days: Day[]) =>
    days.map((d) => (d.sleep ? sleepScore(d.sleep).score : undefined));

  it('waits for 3 earlier nights before scoring', () => {
    const early = steady.slice(0, 3);
    expect(readiness(early, 2, scoresFor(early))).toMatchObject({ score: undefined, nights: 2 });
  });

  it('is high when HRV is up and resting HR down, low after a rough night', () => {
    const good = [...steady, day(date(10), { hrv: 58, rhr: 55, sleep: night(470, date(10)) })];
    const bad = [...steady, day(date(10), { hrv: 32, rhr: 68, sleep: night(260, date(10)) })];
    expect((readiness(good, 10, scoresFor(good)) as Score).band).toBe('green');
    expect((readiness(bad, 10, scoresFor(bad)) as Score).band).toBe('red');
  });

  it('labels the calibration stage by nights of data', () => {
    const d = [...steady, day(date(10), { hrv: 51, rhr: 58, sleep: night(450, date(10)) })];
    expect((readiness(d, 10, scoresFor(d)) as Score).stage).toBe('building');
  });
});

describe('strain', () => {
  it('ignores sleep and easy minutes, and counts hard ones', () => {
    const start = dayStart('2026-10-10');
    const list = new Array<number | null>(288).fill(70);
    for (let i = 240; i < 252; i++) list[i] = 150;
    const asleep: Array<[number, number]> = [[start, start + 6 * 3_600_000]];
    expect(trimp(list, start, 60, 189, asleep)).toBeGreaterThan(40);
    expect(trimp(new Array(288).fill(72), start, 60, 189, [])).toBe(0);
  });

  it('maps load onto 0 to 21 with diminishing returns', () => {
    expect(strainFromTrimp(0)).toBe(0);
    expect(strainFromTrimp(100)).toBeCloseTo(11.9, 1);
    expect(strainFromTrimp(1000)).toBeLessThanOrEqual(21);
  });
});

describe('loadBalance', () => {
  it('stays descriptive until two weeks of data exist', () => {
    expect(loadBalance([10, 20, 30]).status).toBe('building');
    const steadyWeeks = Array.from({ length: 28 }, () => 40);
    expect(loadBalance(steadyWeeks)).toMatchObject({ status: 'in your usual range', ratio: 1 });
  });
});

describe('norms and dates', () => {
  it('uses the Fitbit population HRV norm for his age', () => {
    expect(hrvNorm(27)).toBeCloseTo(48.7, 0);
    expect(hrvNorm(30)).toBeCloseTo(44.8, 1);
  });

  it('works out real age and averages clock times across midnight', () => {
    expect(realAge('1990-01-01', '2026-10-11')).toBeCloseTo(36.8, 1);
    expect(meanClock([1410, 30])).toBe(0);
  });

  it('ignores missing values in baselines', () => {
    expect(baseline([10, undefined, 20])).toEqual({ mean: 15, sd: 7.1, n: 2 });
  });
});

describe('sleep profile and regularity', () => {
  it('reports a night owl for very late sleep', () => {
    const late = [day('2026-10-10', { sleep: night(300, '2026-10-10', 210) })];
    expect(sleepProfile(late)?.chronotype).toBe('Night owl');
  });

  it('measures sleep debt against the 7h30 goal and counts naps', () => {
    const nights = [
      day(date(0), { sleep: night(420) }),
      day(date(1), { sleep: { ...night(400), naps: 1, napMin: 50 } }),
    ];
    expect(sleepProfile(nights)?.sleepDebt7dMinutes).toBe(30);
  });

  it('scores identical nights as perfectly regular and needs 5 nights', () => {
    const same = Array.from({ length: 6 }, (_, i) => day(date(i), { sleep: night(420, date(i)) }));
    expect(sleepRegularity(same, dayStart)).toBe(100);
    expect(sleepRegularity(same.slice(0, 3), dayStart)).toBeUndefined();
  });
});

describe('bodyAge', () => {
  const build = (n: number, extra: Partial<Day>) =>
    Array.from({ length: n }, (_, i) => day(date(i), { sleep: night(470, date(i)), ...extra }));

  it('holds back the number until a week of full days exists', () => {
    const few = build(3, { rhr: 60, steps: 9000 });
    const result = bodyAge({ days: few, complete: few, age: 27 });
    expect(result.bodyAge).toBeUndefined();
    expect(result.stage).toBe('early');
  });

  it('is younger for strong habits and older for poor ones', () => {
    const fit = build(14, { rhr: 52, steps: 11500, azm: 45 });
    const unfit = build(14, { rhr: 84, steps: 3000, azm: 2, sleep: night(320) });
    const strong = bodyAge({ days: fit, complete: fit, age: 27, strengthMinutesPerWeek: 90 });
    const weak = bodyAge({ days: unfit, complete: unfit, age: 27, strengthMinutesPerWeek: 0 });
    expect(strong.bodyAge).toBeLessThan(27);
    expect(weak.bodyAge).toBeGreaterThan(27);
    expect(strong.stage).toBe('provisional');
  });

  it('marks factors without enough data as pending instead of guessing', () => {
    const few = build(2, { rhr: 60 });
    const pending = bodyAge({ days: few, complete: few, age: 27 }).factors.filter((f) => f.pending);
    expect(pending.map((f) => f.factor)).toContain('Strength training');
    expect(pending.every((f) => f.years === 0)).toBe(true);
  });
});

describe('guidance', () => {
  const sunday = planNight(DEFAULT_SCHEDULE, '2026-10-11');
  const monday = planNight(DEFAULT_SCHEDULE, '2026-10-12');
  const at = (h: number, m = 0) => h * 60 + m;

  it('times the evening from the next alarm', () => {
    expect(sleepTiming(at(12), sunday, monday, true)).toBe(
      'Tonight: wind down from 10:00pm, in bed by 11:00pm for your 7:00am alarm.',
    );
    expect(sleepTiming(at(22), sunday, monday, true)).toMatch(/^Wind down now/);
    expect(sleepTiming(at(23), sunday, monday, true)).toBe(
      'Past your bedtime. Get to bed now, your 7:00am alarm is 8h00 away.',
    );
    expect(sleepTiming(at(1), sunday, monday)).toBe(
      'Past your bedtime. Sleep now, your 7:00am alarm is 6h00 away.',
    );
  });

  it('calls out the early alarm from a date override', () => {
    const saturday = planNight(
      { ...DEFAULT_SCHEDULE, overrides: { '2026-10-17': '04:50' } },
      '2026-10-17',
    );
    expect(sleepTiming(at(20, 30), sunday, saturday, true)).toBe(
      'Wind down now: screens away, lights low. In bed by 9:20pm for your 4:50am shift alarm.',
    );
  });

  it('leads with wind-down in the evening and with last night in the morning', () => {
    const d = day('2026-10-12', { sleep: night(340), steps: 4000 });
    const input = { day: d, isToday: true, lastNight: monday, flags: [] };
    const evening = guidance({ ...input, now: at(22), tonight: monday });
    expect(evening.actions[0]).toMatch(/^Wind down now/);
    expect(evening.headline).toBe('Short night. Still learning your normal.');
    const morning = guidance({ ...input, now: at(9), tonight: monday });
    expect(morning.actions[0]).toBe('You slept 5h40, 1h50 under your 7h30 goal.');
    expect(morning.actions.at(-1)).toMatch(/more steps/);
  });

  it('counts naps in the total and holds weights when the week is short on sleep', () => {
    const green = { score: 74, band: 'green', label: 'High', parts: {} } as Score;
    const d = day('2026-10-13', { sleep: { ...night(258), naps: 1, napMin: 30 } });
    const input = { day: d, isToday: true, lastNight: monday, tonight: monday, flags: [] };
    const tired = guidance({ ...input, readiness: green, now: at(9), debtMin: 507 });
    expect(tired.actions[0]).toBe('You slept 4h48, 2h42 under your 7h30 goal.');
    expect(tired.headline).toBe('Recovered, but short on sleep.');
    expect(tired.training).toMatch(/^Train as planned, but hold your weights: you are 8h27 behind/);
    const rested = guidance({ ...input, readiness: green, now: at(9), debtMin: 60 });
    expect(rested.training).toMatch(/^Push for progress/);
  });

  it('counts calibration nights from HRV readings', () => {
    const days = [day('a', { hrv: 30 }), day('b')];
    expect(calibration(days)).toMatchObject({ nights: 1, done: false });
  });
});
