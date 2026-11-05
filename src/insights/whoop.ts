import { type NightPlan, toClock, toMinute } from './schedule';
import { type Band, clamp, sleepRhr } from './scores';
import type { Day, SleepNight } from './types';

// Whoop publishes inputs, bands and zones, not formulas; sources in docs/scoring-research.md.
const BASE_NEED_MIN = 450;
const MIN_NEED_MIN = 180;
const DEBT_CARRY = 0.5;
const DEBT_CAP_MIN = 180;
const BASELINE_NIGHTS = 14;
const PRIOR_NIGHTS = 4;
const CONSISTENCY_NIGHTS = 4;
const PLANNER_NIGHTS = 28;
export const CALIBRATION_NIGHTS = 4;
export const AGE_NIGHTS = 21;
export const ZONE_EDGES = [0.4, 0.6, 0.7, 0.8, 0.9];

export type HrPoint = { ms: number; bpm: number; min: number };

export type Recovery =
  | {
      score: number;
      band: Band;
      calibrating: boolean;
      nights: number;
      needed: number;
      parts: { hrv: number; restingHr: number; sleep: number; breathing: number };
      context: string[];
    }
  | { score: undefined; reason: string; nights: number; needed: number };

export type SleepNeed = { baseline: number; strain: number; debt: number; naps: number };

export type WhoopSleep = {
  needMin: number;
  need: SleepNeed;
  asleepMin?: number;
  performance?: number;
  label?: string;
  band?: Band;
  hoursVsNeeded?: number;
  efficiency?: number;
  consistency?: number;
  restorativeMin?: number;
  restorativePct?: number;
};

export type WhoopDay = {
  date: string;
  strain?: number;
  sleep: WhoopSleep;
  recovery: Recovery;
  debtAfter: number;
};

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sub = (z: number) => Math.round(50 + 25 * clamp(z, -2, 2));
const logistic = (z: number) => 1 / (1 + Math.exp(-z));

export const whoopHrMax = (age: number) => 192 - 0.007 * age * age;

export const recoveryBand = (score: number): Band =>
  score >= 67 ? 'green' : score >= 34 ? 'yellow' : 'red';

export const sleepBand = (pct: number): Band =>
  pct >= 85 ? 'green' : pct >= 70 ? 'yellow' : 'red';

const SLEEP_LABEL: Record<Band, string> = { green: 'Optimal', yellow: 'Sufficient', red: 'Poor' };

/** Per-minute load weight, roughly doubling each zone and fading out below 20% of reserve. */
export function strainWeight(reservePct: number): number {
  return Math.exp((0.565 * (reservePct - 55)) / 10) / (1 + Math.exp(-(reservePct - 20) / 3));
}

/** Curve fitted to 3,215 Whoop workouts: logarithmic, then softly capped at 21. */
export function whoopStrain(load: number): number {
  const b = 5.46 * Math.log(1 + Math.max(0, load) / 12.3);
  return Math.round(((21 * b) / (b ** 8 + 21 ** 8) ** (1 / 8)) * 10) / 10;
}

export function bucketPoints(list: Array<number | null> | undefined, dayStart: number): HrPoint[] {
  const out: HrPoint[] = [];
  (list ?? []).forEach((bpm, i) => {
    if (bpm !== null) out.push({ ms: dayStart + i * 300_000, bpm, min: 5 });
  });
  return out;
}

/** Five-minute points with workout stretches swapped for their one-minute detail. */
export function withDetail(
  points: HrPoint[],
  detail: Array<{ from: number; to: number; points: HrPoint[] }>,
) {
  const inside = (ms: number, end: number) => detail.some((d) => ms < d.to && end > d.from);
  return [
    ...points.filter((p) => !inside(p.ms, p.ms + p.min * 60_000)),
    ...detail.flatMap((d) => d.points),
  ].sort((a, b) => a.ms - b.ms);
}

export function strainLoad(
  points: HrPoint[],
  rhr: number,
  hrMax: number,
  window?: [number, number],
) {
  return points
    .filter((p) => !window || (p.ms >= window[0] && p.ms < window[1]))
    .reduce((a, p) => a + p.min * strainWeight((100 * (p.bpm - rhr)) / (hrMax - rhr)), 0);
}

export function zoneMinutes(points: HrPoint[], rhr: number, hrMax: number): number[] {
  const out = [0, 0, 0, 0, 0];
  for (const p of points) {
    const zone = ZONE_EDGES.filter((edge) => (p.bpm - rhr) / (hrMax - rhr) >= edge).length - 1;
    if (zone >= 0) out[zone] = (out[zone] ?? 0) + p.min;
  }
  return out;
}

/** Mean and spread of recent nights, the spread blended with a typical one while young. */
function robust(values: Array<number | undefined>, priorSpread: number, floor: number) {
  const xs = values.filter(finite);
  if (!xs.length) return undefined;
  const mean = average(xs);
  const mad = 1.253 * average(xs.map((x) => Math.abs(x - mean)));
  const spread = Math.sqrt(
    (xs.length * mad ** 2 + PRIOR_NIGHTS * priorSpread ** 2) / (xs.length + PRIOR_NIGHTS),
  );
  return { mean, spread: Math.max(spread, floor) };
}

/** Whoop takes resting heart rate during sleep, so use non-REM heart rate when Google has it. */
export const whoopRhr = (d: Day) => d.sleepHr ?? sleepRhr(d);

/** Night HRV weighted towards deep sleep, as Whoop weights slow-wave sleep. */
export const sleepHrv = (d: Day) =>
  d.hrv === undefined ? undefined : d.hrvDeep ? 0.6 * d.hrvDeep + 0.4 * d.hrv : d.hrv;

export function recovery(days: Day[], k: number, sleepPct: number | undefined): Recovery {
  const day = days[k] as Day;
  const prior = days.slice(Math.max(0, k - BASELINE_NIGHTS), k);
  const nights = prior.filter((d) => d.hrv !== undefined).length;
  const needed = CALIBRATION_NIGHTS;
  const hrv = sleepHrv(day);
  if (!day.sleep) return { score: undefined, reason: 'no sleep', nights, needed };
  if (hrv === undefined) return { score: undefined, reason: 'no HRV', nights, needed };
  if (nights === 0) return { score: undefined, reason: 'first night', nights, needed };
  const z = (x: number | undefined, b: ReturnType<typeof robust>) =>
    finite(x) && b ? clamp((x - b.mean) / b.spread, -3, 3) : 0;
  const zHrv = z(
    Math.log(hrv),
    robust(
      prior.map((d) => sleepHrv(d) && Math.log(sleepHrv(d) as number)),
      0.15,
      0.05,
    ),
  );
  const zRhr = -z(whoopRhr(day), robust(prior.map(whoopRhr), 3, 1));
  const zBreath = -z(
    day.breathing,
    robust(
      prior.map((d) => d.breathing),
      0.5,
      0.2,
    ),
  );
  const sleep = sleepPct ?? 85;
  const context: string[] = [];
  if ((day.skinTempDelta ?? 0) > 0.5) context.push('Skin temperature above your baseline');
  if (finite(day.spo2) && day.spo2 < 94) context.push('Blood oxygen below 94%');
  const logit =
    0.7325 +
    0.5978 * zHrv +
    0.0877 * zRhr +
    0.0582 * zBreath +
    0.08 * clamp((sleep - 85) / 15, -3, 0) -
    0.5 * context.length;
  const score = Math.round(clamp(100 * logistic(logit), 1, 99));
  return {
    score,
    band: recoveryBand(score),
    calibrating: nights + 1 <= CALIBRATION_NIGHTS,
    nights,
    needed,
    parts: {
      hrv: sub(zHrv),
      restingHr: sub(zRhr),
      sleep: Math.round(sleep),
      breathing: sub(zBreath),
    },
    context,
  };
}

/** Share of minutes in the same sleep or wake state as each of the previous nights. */
export function sleepConsistency(previous: SleepNight[], night: SleepNight): number | undefined {
  if (previous.length < 2) return undefined;
  const span = (n: SleepNight): [number, number] => {
    const from = (n.bedMinute - 1080 + 1440) % 1440;
    return [from, from + (n.endMs - n.startMs) / 60_000];
  };
  const [a0, a1] = span(night);
  const shares = previous.map((p) => {
    const [b0, b1] = span(p);
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / (Math.max(a1, b1) - Math.min(a0, b0));
  });
  return Math.round(100 * average(shares));
}

/** Whoop's efficiency bands: 90% and up is optimal, under 80% is poor. */
export const efficiencyScore = (eff: number) =>
  eff >= 90 ? 100 : eff >= 80 ? 70 + 3 * (eff - 80) : Math.max(0, (70 * (eff - 50)) / 30);

export function sleepPerformance(sufficiency: number, efficiency?: number, consistency?: number) {
  const parts: Array<[number | undefined, number]> = [
    [Math.min(100, sufficiency), 0.75],
    [consistency, 0.15],
    [efficiency === undefined ? undefined : efficiencyScore(efficiency), 0.1],
  ];
  const known = parts.filter((p): p is [number, number] => p[0] !== undefined);
  const weight = known.reduce((a, [, w]) => a + w, 0);
  return Math.round(known.reduce((a, [v, w]) => a + v * w, 0) / weight);
}

/** Whoop's patented strain term: 37 extra minutes after a strain of 15. */
export const strainNeedMin = (strain: number) =>
  Math.round(102 / (1 + Math.exp((17 - strain) / 3.5)));

export function sleepNeed(strain: number | undefined, debt: number, naps: number) {
  const fromStrain = finite(strain) ? strainNeedMin(strain) : 0;
  const need: SleepNeed = { baseline: BASE_NEED_MIN, strain: fromStrain, debt, naps };
  return { needMin: Math.max(MIN_NEED_MIN, BASE_NEED_MIN + fromStrain + debt - naps), need };
}

/** Every day in order, since each night's need carries the debt and strain before it. */
export function whoopDays(days: Day[], strains: Array<number | undefined>): WhoopDay[] {
  const out: WhoopDay[] = [];
  let debt = 0;
  days.forEach((day, k) => {
    const { needMin, need } = sleepNeed(strains[k - 1], debt, days[k - 1]?.sleep?.napMin ?? 0);
    const n = day.sleep;
    let sleep: WhoopSleep = { needMin, need };
    if (n) {
      const sufficiency = (100 * n.asleep) / needMin;
      const efficiency = n.inBed ? Math.round((100 * n.asleep) / n.inBed) : undefined;
      const previous = days
        .slice(Math.max(0, k - CONSISTENCY_NIGHTS), k)
        .flatMap((d) => (d.sleep ? [d.sleep] : []));
      const consistency = sleepConsistency(previous, n);
      const performance = sleepPerformance(sufficiency, efficiency, consistency);
      const restorative = n.deep === undefined ? undefined : n.deep + (n.rem ?? 0);
      sleep = {
        ...sleep,
        asleepMin: n.asleep,
        performance,
        label: SLEEP_LABEL[sleepBand(performance)],
        band: sleepBand(performance),
        hoursVsNeeded: Math.round(Math.min(100, sufficiency)),
        efficiency,
        consistency,
        restorativeMin: restorative,
        restorativePct:
          restorative === undefined
            ? undefined
            : Math.round((100 * restorative) / Math.max(1, n.asleep)),
      };
      debt = Math.min(DEBT_CAP_MIN, Math.round(DEBT_CARRY * Math.max(0, needMin - n.asleep)));
    }
    out.push({
      date: day.date,
      strain: strains[k],
      sleep,
      recovery: recovery(days, k, sleep.performance),
      debtAfter: debt,
    });
  });
  return out;
}

export function strainTarget(band: Band | undefined): [number, number] | undefined {
  if (!band) return undefined;
  return band === 'green' ? [14, 18] : band === 'yellow' ? [10, 14] : [4, 10];
}

/** Bedtimes for 100%, 85% and 70% of need, using the recent sleep-to-time-in-bed ratio. */
export function sleepPlanner(needMin: number, tonight: NightPlan, efficiencies: number[] = []) {
  const recent = efficiencies.slice(-PLANNER_NIGHTS).sort((a, b) => a - b);
  const median = recent.length >= 3 ? (recent[Math.floor(recent.length / 2)] as number) : 92;
  const eff = clamp(median, 80, 98) / 100;
  const wake = toMinute(tonight.wake);
  return (
    [
      ['Peak', 100],
      ['Perform', 85],
      ['Get by', 70],
    ] as const
  ).map(([name, pct]) => {
    const inBedMin = Math.round((needMin * pct) / 100 / eff);
    return { name, pct, inBedMin, bedtime: toClock(wake - inBedMin) };
  });
}

/** Whoop's 0 to 3 stress from heart rate against resting and max, eased off when moving. */
export function heartStress(bpm: number, rhr: number, hrMax: number, steps = 0): number {
  const reserve = (bpm - rhr) / (hrMax - rhr);
  const score = 3 / (1 + Math.exp(-7.84 * (reserve - 0.2)));
  return Math.round(score * (1 - Math.min(0.5, steps / 600)) * 100) / 100;
}

/** Stress through the day from five-minute heart rate and steps, skipping sleep and exercise. */
export function stressMonitor(
  points: HrPoint[],
  steps: Map<number, number>,
  rhr: number,
  hrMax: number,
  skip: Array<[number, number]>,
) {
  const series = points.map((p) => {
    const moving = steps.get(p.ms) ?? 0;
    const skipped = moving > 150 || skip.some(([a, b]) => p.ms >= a && p.ms < b);
    return { ms: p.ms, v: skipped ? null : heartStress(p.bpm, rhr, hrMax, moving) };
  });
  const scored = series.flatMap((s) => (s.v === null ? [] : [s.v]));
  const minutes = (lo: number, hi: number) => 5 * scored.filter((v) => v >= lo && v < hi).length;
  return {
    series,
    average: scored.length ? Math.round(average(scored) * 10) / 10 : undefined,
    current: [...series].reverse().find((s) => s.v !== null)?.v ?? undefined,
    calm: minutes(0, 1),
    neutral: minutes(1, 2),
    high: minutes(2, 4),
  };
}

/** Share of the night in high stress, mixing heart rate with each HRV sample's percentile. */
export function sleepStress(
  samples: Array<{ ms: number; rmssd: number }>,
  points: HrPoint[],
  lnHrvMean: number,
  lnHrvSpread: number,
  rhr: number,
  hrMax: number,
): number | undefined {
  if (samples.length < 6) return undefined;
  const high = samples.filter((s) => {
    const hr = points.find((p) => s.ms >= p.ms && s.ms < p.ms + p.min * 60_000)?.bpm ?? rhr;
    const z = (Math.log(Math.max(1, s.rmssd)) - lnHrvMean) / lnHrvSpread;
    const hrvScore = 3 * logistic(-1.7 * z);
    return 0.5 * heartStress(hr, rhr, hrMax) + 0.5 * hrvScore >= 2;
  }).length;
  return Math.round((1000 * high) / samples.length) / 10;
}
