import { GOAL_MIN } from './schedule';
import { totalAsleep } from './sleep';
import type { Day, HeartBuckets, SleepNight } from './types';

export const SLEEP_TARGET_MIN = 480;
export const hrMaxFor = (age: number) => 208 - 0.7 * age;
export const BUCKET_MIN = 5;
const STRAIN_HRR_FLOOR = 0.3;
const STRAIN_SCALE = 120;

export type Baseline = { mean: number; sd: number; n: number };
export type Band = 'green' | 'yellow' | 'red';
export type Stage = 'calibrating' | 'building' | 'personal';

export type Score = {
  score: number;
  band: Band;
  label: string;
  parts: Record<string, number>;
  stage?: Stage;
};

export type Pending = { score: undefined; reason: string; nights: number; needed: number };

export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
export const round1 = (v: number) => Math.round(v * 10) / 10;
const mean = (xs: Array<number | undefined>) => {
  const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

export function baseline(values: Array<number | undefined>): Baseline | undefined {
  const xs = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (xs.length === 0) return undefined;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd =
    xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean: round1(m), sd: round1(sd), n: xs.length };
}

/** The 30 days before `index`, so a day is never compared with itself. */
export function priorBaseline(days: Day[], index: number, pick: (d: Day) => number | undefined) {
  return baseline(days.slice(Math.max(0, index - 30), index).map(pick));
}

/** Resting HR worked out with sleep only, as the awake-only fallback reads higher. */
export const sleepRhr = (d: Day) => (d.rhrWithSleep === false ? undefined : d.rhr);

/** Typical overnight RMSSD for men on Fitbit, from Natarajan et al. (8.2M users). */
export function hrvNorm(age: number): number {
  return 44.8 * (age / 30) ** -0.804;
}

export function stageFor(nights: number): Stage {
  if (nights >= 14) return 'personal';
  return nights >= 7 ? 'building' : 'calibrating';
}

export function nightsBefore(days: Day[], index: number): number {
  return days.slice(0, index).filter((d) => d.hrv !== undefined).length;
}

/** Share of sleep spent below resting heart rate, from five-minute averages. */
export function shareBelowResting(
  night: SleepNight,
  buckets: Map<string, HeartBuckets>,
  dayStartMs: (date: string) => number,
  rhr: number | undefined,
): number | undefined {
  if (rhr === undefined) return undefined;
  let below = 0;
  let total = 0;
  for (const [date, list] of buckets) {
    const start = dayStartMs(date);
    if (start > night.endMs || start + 86_400_000 < night.startMs) continue;
    list.forEach((v, i) => {
      const t = start + i * BUCKET_MIN * 60_000;
      if (v === null || t < night.startMs || t >= night.endMs) return;
      total += 1;
      if (v < rhr) below += 1;
    });
  }
  return total >= 6 ? below / total : undefined;
}

/** Classic Fitbit structure: duration 50, deep and REM 25, restoration 25. */
export function sleepScore(night: SleepNight, sleepHr?: number, rhr?: number, below?: number) {
  const duration = 50 * clamp(night.asleep / SLEEP_TARGET_MIN, 0, 1);
  const restorative = (night.deep ?? 0) + (night.rem ?? 0);
  const quality =
    night.deep === undefined ? 15 : 25 * clamp(restorative / Math.max(1, 0.4 * night.asleep), 0, 1);
  const share =
    below ??
    (sleepHr !== undefined && rhr !== undefined
      ? clamp(0.5 + (rhr - sleepHr) / (0.1 * rhr), 0, 1)
      : 0.6);
  const settled = 15 * share + 10 * (1 - Math.min(1, night.awake / 60));
  const score = Math.round(duration + quality + settled);
  const label = score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 60 ? 'Fair' : 'Poor';
  const band: Band = score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
  return {
    score,
    band,
    label,
    parts: {
      duration: Math.round(duration),
      deepAndRem: Math.round(quality),
      restoration: Math.round(settled),
    },
  } satisfies Score;
}

const sub = (z: number) => 50 + 25 * Math.max(-2, Math.min(2, z));

/** Google-style readiness: HRV, resting HR and a week of sleep; none before 3 earlier nights. */
export function readiness(
  days: Day[],
  index: number,
  sleepScores: Array<number | undefined>,
): Score | Pending | undefined {
  const day = days[index];
  if (!day) return undefined;
  const nights = nightsBefore(days, index);
  if (nights < 3) return { score: undefined, reason: 'learning', nights, needed: 3 };
  if (!day.sleep || day.sleep.asleep < 180 || day.hrv === undefined) {
    return { score: undefined, reason: 'short sleep', nights, needed: 3 };
  }
  const lnHrv = priorBaseline(days, index, (d) => (d.hrv ? Math.log(d.hrv) : undefined));
  const rhrBase = priorBaseline(days, index, sleepRhr);
  const hrvZ = lnHrv ? (Math.log(day.hrv) - lnHrv.mean) / Math.max(lnHrv.sd, 0.1) : 0;
  const rhr = sleepRhr(day);
  const rhrZ = rhrBase && rhr !== undefined ? -(rhr - rhrBase.mean) / Math.max(rhrBase.sd, 1.5) : 0;
  const week = mean(sleepScores.slice(Math.max(0, index - 6), index + 1));
  const sleep = 0.6 * (sleepScores[index] ?? week ?? 50) + 0.4 * (week ?? 50);
  const score = Math.round(clamp(0.45 * sub(hrvZ) + 0.25 * sub(rhrZ) + 0.3 * sleep, 1, 100));
  const band: Band = score >= 65 ? 'green' : score >= 30 ? 'yellow' : 'red';
  return {
    score,
    band,
    label: band === 'green' ? 'High' : band === 'yellow' ? 'Moderate' : 'Low',
    parts: {
      hrv: Math.round(sub(hrvZ)),
      restingHr: Math.round(sub(rhrZ)),
      sleep: Math.round(sleep),
    },
    stage: stageFor(nights),
  };
}

/** Heart rate reserve for each awake five-minute bucket, optionally inside [from, to). */
export function awakeReserve(
  list: HeartBuckets | undefined,
  dayStart: number,
  rhr: number,
  hrMax: number,
  asleep: Array<[number, number]>,
  window?: [number, number],
): number[] {
  const out: number[] = [];
  (list ?? []).forEach((v, i) => {
    if (v === null) return;
    const t = dayStart + i * BUCKET_MIN * 60_000;
    if (window && (t < window[0] || t >= window[1])) return;
    if (asleep.some(([a, b]) => t >= a && t < b)) return;
    out.push((v - rhr) / (hrMax - rhr));
  });
  return out;
}

/** Banister TRIMP from awake five-minute heart rate above 30% of heart rate reserve. */
export function trimp(
  list: HeartBuckets | undefined,
  dayStart: number,
  rhr: number,
  hrMax: number,
  asleep: Array<[number, number]>,
  window?: [number, number],
): number {
  const total = awakeReserve(list, dayStart, rhr, hrMax, asleep, window)
    .filter((reserve) => reserve >= STRAIN_HRR_FLOOR)
    .reduce((a, reserve) => a + BUCKET_MIN * reserve * 0.64 * Math.exp(1.92 * reserve), 0);
  return round1(total);
}

export function strainFromTrimp(load: number): number {
  return round1(21 * (1 - Math.exp(-load / STRAIN_SCALE)));
}

export function strainLabel(value: number): string {
  if (value >= 18) return 'All out';
  if (value >= 14) return 'High';
  return value >= 10 ? 'Moderate' : 'Light';
}

/** Exponentially weighted 7 and 28 day loads, described, never used to predict injury. */
export function loadBalance(daily: Array<number | undefined>) {
  const known = daily.filter((v) => v !== undefined).length;
  let acute: number | undefined;
  let chronic: number | undefined;
  for (const v of daily) {
    const x = v ?? 0;
    acute = acute === undefined ? x : acute + (2 / 8) * (x - acute);
    chronic = chronic === undefined ? x : chronic + (2 / 29) * (x - chronic);
  }
  const week = round1(daily.slice(-7).reduce<number>((a, v) => a + (v ?? 0), 0));
  if (known < 14 || !chronic) return { status: 'building', week, daysOfData: known };
  const ratio = round1((acute ?? 0) / chronic);
  const status =
    ratio < 0.8
      ? 'below your usual'
      : ratio <= 1.3
        ? 'in your usual range'
        : ratio <= 1.5
          ? 'above your usual'
          : 'well above your usual';
  return {
    status,
    ratio,
    week,
    target: [round1(chronic * 7 * 0.8), round1(chronic * 7 * 1.3)],
    daysOfData: known,
  };
}

/** Fitbit's 30/40/30 split, shown with Google's 2026 Resilience labels. */
export function resilience(days: Day[], index: number, ratio: number | undefined) {
  const day = days[index];
  if (!day || nightsBefore(days, index) < 3) return undefined;
  const lnHrv = priorBaseline(days, index, (d) => (d.hrv ? Math.log(d.hrv) : undefined));
  const rhrBase = priorBaseline(days, index, sleepRhr);
  const z10 = (z: number) => 10 * clamp((z + 2) / 4, 0, 1);
  const rhr = sleepRhr(day);
  const respond =
    (day.hrv && lnHrv ? z10((Math.log(day.hrv) - lnHrv.mean) / Math.max(lnHrv.sd, 0.1)) : 5) +
    (rhr !== undefined && rhrBase ? z10(-(rhr - rhrBase.mean) / Math.max(rhrBase.sd, 1.5)) : 5) +
    (day.sleepHr !== undefined && rhr !== undefined
      ? 10 * clamp((rhr * 1.05 - day.sleepHr) / (0.1 * rhr), 0, 1)
      : 5);
  const recent = days.slice(Math.max(0, index - 7), index);
  const steps = mean(recent.map((d) => d.steps)) ?? 0;
  const azmWeek = recent.reduce((a, d) => a + (d.azm ?? 0), 0) * (7 / Math.max(1, recent.length));
  const balance =
    ratio === undefined
      ? 10
      : 20 * clamp(ratio < 0.8 ? (ratio - 0.5) / 0.3 : ratio > 1.3 ? (1.8 - ratio) / 0.5 : 1, 0, 1);
  const exertion = balance + 10 * Math.min(1, steps / 8000) + 10 * Math.min(1, azmWeek / 150);
  const week = days.slice(Math.max(0, index - 6), index + 1);
  const debt = week.reduce(
    (a, d) => a + (d.sleep ? Math.max(0, GOAL_MIN - totalAsleep(d.sleep)) : 0),
    0,
  );
  const night = day.sleep;
  const restorative = night ? (night.deep ?? 0) + (night.rem ?? 0) : 0;
  const sleep =
    15 * clamp(1 - debt / 420, 0, 1) +
    7.5 * (night ? 1 - Math.min(1, night.awake / 60) : 0.5) +
    7.5 *
      (night?.deep !== undefined
        ? Math.min(1, restorative / Math.max(1, 0.4 * night.asleep))
        : 0.5);
  const score = Math.round(clamp(respond + exertion + sleep, 1, 100));
  const band: Band = score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red';
  return {
    score,
    band,
    label: band === 'green' ? 'Optimal' : band === 'yellow' ? 'Balanced' : 'Low',
    parts: {
      responsiveness: Math.round(respond),
      exertionBalance: Math.round(exertion),
      sleepPatterns: Math.round(sleep),
    },
  } satisfies Score;
}

/** Uth et al. estimate from resting and age-predicted max heart rate. */
export function estimatedVo2(rhr: number | undefined, age: number): number | undefined {
  if (!rhr) return undefined;
  return round1((15.3 * hrMaxFor(age)) / rhr);
}
