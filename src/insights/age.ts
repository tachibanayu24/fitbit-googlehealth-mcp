import { GOAL_MIN } from './schedule';
import { baseline, round1, sleepRhr } from './scores';
import { totalAsleep } from './sleep';
import type { Day } from './types';

export type AgeFactor = {
  factor: string;
  value: string;
  years: number;
  tip: string;
  pending?: boolean;
};

export type BodyAge = {
  realAge: number;
  bodyAge?: number;
  difference?: number;
  stage: 'early' | 'provisional' | 'settled';
  daysOfData: number;
  daysNeeded: number;
  factors: AgeFactor[];
  biggestWins: string[];
  note: string;
};

const FIRST_ESTIMATE_DAYS = 7;
const OVERLAP_SHRINK = 0.5;

const clockMinute = (m: number) => ((m % 1440) + 1440) % 1440;

export function clock(m: number): string {
  const v = Math.round(clockMinute(m));
  return `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** Mean of clock times centred on noon, so 23:30 and 00:30 average to midnight. */
export function meanClock(minutes: number[]): number | undefined {
  if (!minutes.length) return undefined;
  const shifted = minutes.map((m) => (clockMinute(m) + 720) % 1440);
  return clockMinute(shifted.reduce((a, b) => a + b, 0) / shifted.length - 720);
}

export function sleepProfile(days: Day[]) {
  const nights = days.map((d) => d.sleep).filter((s) => s !== undefined);
  if (!nights.length) return undefined;
  const mids = nights.map((n) => clockMinute(n.bedMinute + n.inBed / 2));
  const midBase = baseline(mids.map((m) => (m + 720) % 1440));
  const asleep = baseline(nights.map((n) => n.asleep));
  const pct = (pick: (n: (typeof nights)[number]) => number | undefined) =>
    round1(
      (100 * nights.reduce((a, n) => a + (pick(n) ?? 0), 0)) /
        Math.max(
          1,
          nights.reduce((a, n) => a + n.asleep, 0),
        ),
    );
  const midpoint = meanClock(mids) ?? 0;
  const last7 = days
    .slice(-7)
    .map((d) => d.sleep && totalAsleep(d.sleep))
    .filter((v) => v !== undefined);
  const debt = last7.reduce<number>(
    (a, v) => a + (v === undefined ? 0 : Math.max(0, GOAL_MIN - v)),
    0,
  );
  const chronotype =
    (midpoint + 720) % 1440 < 900
      ? 'Early bird'
      : (midpoint + 720) % 1440 < 990
        ? 'In between'
        : 'Night owl';
  return {
    nights: nights.length,
    averageAsleep: Math.round(asleep?.mean ?? 0),
    averageBedtime: clock(meanClock(nights.map((n) => n.bedMinute)) ?? 0),
    averageWake: clock(meanClock(nights.map((n) => n.wakeMinute)) ?? 0),
    midpoint: clock(midpoint),
    consistencyMinutes: Math.round(midBase?.sd ?? 0),
    deepPercent: pct((n) => n.deep),
    remPercent: pct((n) => n.rem),
    sleepDebt7dMinutes: Math.round(debt),
    sleepDebtNights: last7.length,
    chronotype,
  };
}

export function realAge(birthDate: string, on: string): number {
  const b = Date.parse(`${birthDate}T00:00:00Z`);
  return round1((Date.parse(`${on}T00:00:00Z`) - b) / (365.2425 * 86_400_000));
}

/** Real age only when BIRTH_DATE is set; age-based output is skipped when it is not. */
export function optionalAge(birthDate: string | undefined, on: string): number | undefined {
  return birthDate ? realAge(birthDate, on) : undefined;
}

/** Sleep Regularity Index: how often he is in the same sleep or wake state 24 hours apart. */
export function sleepRegularity(days: Day[], dayStart: (date: string) => number) {
  const nights = days.map((d) => d.sleep).filter((n) => n !== undefined);
  const asleep = (t: number) => nights.some((n) => t >= n.startMs && t < n.endMs);
  const observedUntil = Math.max(0, ...nights.map((n) => n.endMs));
  let same = 0;
  let total = 0;
  for (let i = 0; i + 1 < days.length; i++) {
    const a = days[i] as Day;
    const b = days[i + 1] as Day;
    if (!a.sleep || !b.sleep) continue;
    const start = dayStart(a.date);
    for (let m = 0; m < 1440; m += 5) {
      const t = start + m * 60_000;
      if (t + 86_400_000 >= observedUntil) break;
      if (asleep(t) === asleep(t + 86_400_000)) same += 1;
      total += 1;
    }
  }
  const pairs = total / 288;
  return pairs >= 4 ? round1(200 * (same / total) - 100) : undefined;
}

/** Years from a hazard ratio, using Whoop's 10% higher mortality per year of age. */
const yearsFromRatio = (ratio: number) => 10 * Math.log(ratio);

function interpolate(x: number, points: Array<[number, number]>): number {
  const first = points[0] as [number, number];
  const last = points[points.length - 1] as [number, number];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i] as [number, number];
    const [x0, y0] = points[i - 1] as [number, number];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

const hm = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;

/**
 * Whoop-style body age. Each factor's published mortality effect becomes years, overlapping
 * factors are shrunk, and no number is shown until a week of data exists.
 */
export function bodyAge(input: {
  days: Day[];
  complete: Day[];
  age: number;
  strengthMinutesPerWeek?: number;
  regularity?: number;
}): BodyAge {
  const { days, complete, age } = input;
  const factors: AgeFactor[] = [];
  const add = (factor: string, value: string, raw: number, tip: string) =>
    factors.push({
      factor,
      value,
      years: round1(OVERLAP_SHRINK * Math.max(-4, Math.min(4, raw))),
      tip,
    });
  const wait = (factor: string, value: string, tip: string) =>
    factors.push({ factor, value, years: 0, tip, pending: true });

  const rhr = baseline(days.map(sleepRhr));
  if (rhr && rhr.n >= 3) {
    add(
      'Resting heart rate',
      `${Math.round(rhr.mean)} bpm average while asleep`,
      0.086 * (Math.max(45, rhr.mean) - 60),
      'Under 60 is the target. Zone 2 cardio and earlier nights bring it down',
    );
  } else wait('Resting heart rate', 'Needs 3 nights', 'Under 60 is the target');

  const steps = baseline(complete.map((d) => d.steps));
  if (steps && steps.n >= 3) {
    const ratio = Math.exp(
      interpolate(steps.mean, [
        [3553, 0],
        [5801, Math.log(0.6)],
        [7842, Math.log(0.55)],
        [10901, Math.log(0.47)],
      ]),
    );
    add(
      'Daily steps',
      `${Math.round(steps.mean).toLocaleString('en-AU')} a day on full days`,
      yearsFromRatio(ratio / 0.55),
      'Benefit grows up to about 10,000 a day',
    );
  } else wait('Daily steps', 'Needs 3 full days', 'Benefit grows up to about 10,000 a day');

  const sleep = baseline(days.map((d) => d.sleep?.asleep));
  if (sleep && sleep.n >= 3) {
    const h = sleep.mean / 60;
    add(
      'Sleep duration',
      `${hm(sleep.mean)} a night`,
      h < 6 ? 1.1 : h < 7 ? 0.6 : h <= 9 ? -0.3 : 0,
      'Seven to nine hours is the target',
    );
  } else wait('Sleep duration', 'Needs 3 nights', 'Seven to nine hours is the target');

  if (input.regularity !== undefined) {
    const sri = input.regularity;
    add(
      'Sleep regularity',
      `regularity index ${Math.round(sri)} of 100`,
      sri < 71.6 ? 2.9 : sri < 78.6 ? 0.6 : sri < 83.2 ? 0 : sri < 87.3 ? -0.4 : -0.7,
      'Same bedtime and wake time every day, weekends too',
    );
  } else
    wait('Sleep regularity', 'Needs 5 nights in a row', 'Same bedtime and wake time every day');

  if (complete.length >= FIRST_ESTIMATE_DAYS) {
    const weekly = (complete.reduce((a, d) => a + (d.azm ?? 0), 0) / complete.length) * 7;
    add(
      'Weekly zone minutes',
      `${Math.round(weekly)} a week`,
      interpolate(weekly, [
        [0, 2.1],
        [75, 1],
        [150, 0],
        [300, -0.5],
      ]),
      '150 or more a week',
    );
  } else
    wait('Weekly zone minutes', `Needs ${FIRST_ESTIMATE_DAYS} full days`, '150 or more a week');

  if (input.strengthMinutesPerWeek !== undefined) {
    const m = input.strengthMinutesPerWeek;
    add(
      'Strength training',
      `about ${Math.round(m)} min a week logged`,
      m === 0 ? 0.8 : m < 40 ? 0.4 : -0.8,
      '40 to 120 minutes a week',
    );
  } else wait('Strength training', 'No strength sessions logged yet', '40 to 120 minutes a week');

  const vo2 = baseline(days.map((d) => d.vo2));
  if (vo2) {
    add(
      'VO2 max',
      `${round1(vo2.mean)} ml/kg/min`,
      -0.4 * (vo2.mean - 45),
      'Intervals and longer cardio raise it',
    );
  } else
    wait('VO2 max', 'Needs a run outdoors with your phone', 'Google measures it from GPS runs');

  const daysOfData = complete.length;
  const total = Math.max(
    -10,
    Math.min(
      10,
      factors.reduce((a, f) => a + f.years, 0),
    ),
  );
  const ready = daysOfData >= FIRST_ESTIMATE_DAYS;
  return {
    realAge: round1(age),
    bodyAge: ready ? round1(age + total) : undefined,
    difference: ready ? round1(total) : undefined,
    stage: daysOfData >= 30 ? 'settled' : ready ? 'provisional' : 'early',
    daysOfData,
    daysNeeded: FIRST_ESTIMATE_DAYS,
    factors: factors.sort(
      (a, b) => Number(a.pending ?? false) - Number(b.pending ?? false) || b.years - a.years,
    ),
    biggestWins: factors
      .filter((f) => f.years > 0)
      .slice(0, 3)
      .map((f) => `${f.factor}: ${f.tip}`),
    note: "Modelled on Whoop's published method: each habit's effect on long-term health from large studies, turned into years. A wellness estimate, not a medical test.",
  };
}
