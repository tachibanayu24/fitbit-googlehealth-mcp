import type { Env } from '../env';
import { cacheGeneration } from '../lib/cache';
import { localDayStartUtc, today, toLocalTimeString } from '../lib/date';
import { addDays } from '../providers/google-health/client';
import { bodyAge, optionalAge, sleepProfile, sleepRegularity } from './age';
import { EXERCISE_CACHE_GROUP, InsightsData, type Rows, stepsByHour } from './data';
import { calibration, guidance } from './guidance';
import { planNight, scheduleOf, toMinute } from './schedule';
import {
  baseline,
  estimatedVo2,
  hrMaxFor,
  hrvNorm,
  loadBalance,
  priorBaseline,
  readiness,
  resilience,
  round1,
  type Score,
  shareBelowResting,
  sleepRhr,
  sleepScore,
  strainLabel,
  trimp,
} from './scores';
import type { Day, DayDetail, NightDetail } from './types';
import type { HrPoint } from './whoop';
import { bucketsFromMinutes, buildWhoop, type HrvNight, hrvNight } from './whoop-report';

const HISTORY_DAYS = 90;
const BASE_DAYS = 35;
const CACHE_VERSION = 'v11';
const FRESH_TODAY_MS = 45_000;
const FRESH_PAST_MS = 2 * 3_600_000;
const NIGHT_FRESH_MS = 15 * 60_000;
const NIGHT_WAITING_MS = 2 * 60_000;
const ACTIVITY_FRESH_MS = 5 * 60_000;
const REFRESH_KEEPS_MS = 60_000;
const MINUTES_BEFORE_MS = 3 * 3_600_000;
const MINUTES_AFTER_MS = 6 * 3_600_000;
const KEEP_SEC = 3 * 86_400;
const MIN_BASELINE_NIGHTS = 3;
/** Max heart rate used for zone/strain maths when BIRTH_DATE is not set. */
export const MAX_HR_WITHOUT_AGE = 180;
const DAY_MS = 86_400_000;

/**
 * The day's age context. Without BIRTH_DATE there is no age, so age-based
 * report output (real/body age, HRV norm, VO2 estimate) is skipped and the
 * zone/strain maths fall back to a neutral max-HR estimate.
 */
export function ageContext(
  env: Pick<Env, 'BIRTH_DATE'>,
  date: string,
): {
  age?: number;
  hrMax: number;
} {
  const age = optionalAge(env.BIRTH_DATE, date);
  return { age, hrMax: age === undefined ? MAX_HR_WITHOUT_AGE : hrMaxFor(age) };
}

function vital(days: Day[], i: number, pick: (d: Day) => number | undefined, unit: string) {
  const value = pick(days[i] as Day);
  const base = priorBaseline(days, i, pick);
  const ready = !!base && base.n >= MIN_BASELINE_NIGHTS;
  return {
    value,
    unit,
    average: ready ? base?.mean : undefined,
    range:
      ready && base
        ? [
            round1(base.mean - 2 * Math.max(base.sd, 0.5)),
            round1(base.mean + 2 * Math.max(base.sd, 0.5)),
          ]
        : undefined,
    nights: base?.n ?? 0,
    trend: days.slice(Math.max(0, i - 13), i + 1).map((d) => ({ date: d.date, v: pick(d) })),
  };
}

function flags(days: Day[], i: number): string[] {
  const d = days[i] as Day;
  const out: string[] = [];
  const check = (pick: (x: Day) => number | undefined, floor: number, text: string) => {
    const v = pick(d);
    const b = priorBaseline(days, i, pick);
    if (v !== undefined && b && b.n >= 5 && v > b.mean + Math.max(2 * b.sd, floor)) out.push(text);
  };
  check(
    sleepRhr,
    5,
    'Resting heart rate is well above your normal. Take it easy if you feel run down.',
  );
  check((x) => x.breathing, 1.5, 'Breathing rate during sleep is above your normal.');
  if ((d.skinTempDelta ?? 0) > 0.5) out.push('Skin temperature is above your baseline.');
  if (d.spo2 !== undefined && d.spo2 < 92) {
    out.push(
      `Overnight oxygen averaged ${d.spo2}%. Recheck over the next nights, and see a GP if it stays low.`,
    );
  }
  const short = days
    .slice(Math.max(0, i - 3), i + 1)
    .filter((x) => x.sleep && x.sleep.asleep < 300);
  if (short.length >= 3) out.push('Under 5 hours of sleep on 3 of the last 4 nights.');
  return out;
}

type Night = { rows: Rows; detail?: NightDetail; hrv?: HrvNight };
type Activity = { rows: Rows; extras?: Omit<DayDetail, 'stepsByHour'> };
type Tier<T> = { at: number; start: string; gen?: string; value: T };
type Tiers = { night?: Tier<Night>; activity?: Tier<Activity> };
type Report = Awaited<ReturnType<typeof compute>>['report'];
type Stored = { at: number; report: Report; tiers?: Tiers };
type TrendRow = {
  partial?: boolean;
  readiness?: number;
  recovery?: number;
  sleepPerformance?: number;
  sleepScore?: number;
  asleepMin?: number;
  rhr?: number;
  hrv?: number;
  steps?: number;
  strain?: number;
};

const baseFor = (span: number) => (span <= BASE_DAYS ? BASE_DAYS : HISTORY_DAYS);
export const reportKey = (date: string, base: number) =>
  `insights:${CACHE_VERSION}:${date}:${base}`;
const spanOf = (days: number | undefined) => Math.min(HISTORY_DAYS, Math.max(7, days ?? 30));

export async function forgetReports(env: Env, date: string): Promise<void> {
  await Promise.all([BASE_DAYS, HISTORY_DAYS].map((n) => env.CACHE.delete(reportKey(date, n))));
}

function trendsOf<R extends TrendRow>(rows: R[], days: number) {
  const window = rows.slice(-days);
  const full = window.filter((r) => !r.partial);
  const avg = (pick: (r: R) => number | undefined, list = full) => baseline(list.map(pick))?.mean;
  return {
    days,
    averages: {
      readiness: avg((r) => r.readiness, window),
      recovery: avg((r) => r.recovery, window),
      sleepPerformance: avg((r) => r.sleepPerformance, window),
      sleepScore: avg((r) => r.sleepScore, window),
      asleepMin: avg((r) => r.asleepMin, window),
      rhr: avg((r) => r.rhr, window),
      hrv: avg((r) => r.hrv, window),
      steps: avg((r) => r.steps),
      strain: avg((r) => r.strain),
    },
    rows: window,
  };
}

const forSpan = (report: Report, span: number): Report => ({
  ...report,
  trends: trendsOf(report.trends.rows, span),
});

const building = new Map<string, Promise<Report>>();

async function refresh(env: Env, date: string, base: number, tiers?: Tiers): Promise<Report> {
  const { report, tiers: next } = await compute(env, date, base, tiers);
  const stored: Stored = { at: Date.now(), report, tiers: next };
  await env.CACHE.put(reportKey(date, base), JSON.stringify(stored), { expirationTtl: KEEP_SEC });
  return report;
}

/** A refresh tap still reuses parts fetched in the last minute, so taps in a row stay quick. */
function recentOnly(tiers: Tiers | undefined): Tiers | undefined {
  const young = <T>(t?: Tier<T>) => (t && Date.now() - t.at < REFRESH_KEEPS_MS ? t : undefined);
  return tiers && { night: young(tiers.night), activity: young(tiers.activity) };
}

/** The newest saved report at any age, for an instant first paint while a fresh one builds. */
export async function peekReport(env: Env, opts: { date?: string; days?: number } = {}) {
  const date = opts.date ?? today();
  const span = spanOf(opts.days);
  const hit = await env.CACHE.get<Stored>(reportKey(date, baseFor(span)), 'json');
  if (!hit) return undefined;
  const fresh = Date.now() - hit.at < (date === today() ? FRESH_TODAY_MS : FRESH_PAST_MS);
  return { ...forSpan(hit.report, span), stale: !fresh };
}

export async function buildReport(
  env: Env,
  opts: {
    date?: string;
    days?: number;
    fresh?: boolean;
    keepAlive?: (job: Promise<unknown>) => void;
  } = {},
): Promise<Report> {
  const date = opts.date ?? today();
  const span = spanOf(opts.days);
  const base = baseFor(span);
  const key = reportKey(date, base);
  const pending = building.get(key);
  if (pending) return forSpan(await pending, span);
  const hit = await env.CACHE.get<Stored>(key, 'json');
  const limit = date === today() ? FRESH_TODAY_MS : FRESH_PAST_MS;
  if (!opts.fresh && hit && Date.now() - hit.at < limit) return forSpan(hit.report, span);
  const job = refresh(env, date, base, opts.fresh ? recentOnly(hit?.tiers) : hit?.tiers);
  building.set(key, job);
  const settled = job.finally(() => building.delete(key));
  // The phone often closes the app mid-build; finishing anyway warms the next open.
  opts.keepAlive?.(settled.catch(() => undefined));
  return forSpan(await job, span);
}

async function loadNight(data: InsightsData, start: string, date: string): Promise<Night> {
  const rows = await data.nightRows(start, date);
  const night = rows.find(([d]) => d === date)?.[1].sleep;
  if (!night) return { rows };
  const [detail, hrv] = await Promise.all([
    data.night(date, night).catch(() => undefined),
    data
      .hrvSamples(night.startMs - 7 * DAY_MS, night.endMs)
      .then((samples) => hrvNight(samples, night))
      .catch(() => undefined),
  ]);
  return { rows, detail, hrv };
}

async function loadActivity(data: InsightsData, start: string, date: string): Promise<Activity> {
  const [rows, extras] = await Promise.all([
    data.activityRows(start, date),
    data.dayExtras(date).catch(() => undefined),
  ]);
  return { rows, extras };
}

async function compute(env: Env, date: string, span: number, previous?: Tiers) {
  const data = new InsightsData(env);
  const firstDay = env.DATA_START ?? '0000-00-00';
  const earliest = addDays(date, -(Math.max(span, BASE_DAYS) - 1));
  const start = earliest < firstDay && firstDay <= date ? firstDay : earliest;
  // Age-based output (real/body age, HRV norm, VO2 estimate) is skipped without BIRTH_DATE.
  const { age, hrMax } = ageContext(env, date);
  const now = today();
  const isToday = date === now;
  const dayStart = (d: string) => localDayStartUtc(d).getTime();
  const heartFrom = addDays(start > firstDay ? start : firstDay, -1);
  const nowMs = Date.now();
  const from = dayStart(date);
  const to = Math.min(from + DAY_MS, nowMs);
  // Live parts first, so they get the Worker's first connections.
  const minutesJob = data
    .minuteHr(from - MINUTES_BEFORE_MS, Math.min(nowMs, from + DAY_MS + MINUTES_AFTER_MS))
    .catch(() => [] as HrPoint[]);
  const stepsJob = data.stepsBy5Min(from, to).catch(() => new Map<number, number>());
  const kcalJob = isToday ? data.caloriesOn(date).catch(() => undefined) : undefined;
  const gen = await cacheGeneration(env, EXERCISE_CACHE_GROUP);
  const usable = <T>(t: Tier<T> | undefined, maxAge: number, g?: string) =>
    isToday && t && t.start === start && nowMs - t.at < maxAge && t.gen === g ? t : undefined;
  const hadSleep = previous?.night?.value.rows.some(([d, part]) => d === date && part.sleep);
  const nightJob =
    usable(previous?.night, hadSleep ? NIGHT_FRESH_MS : NIGHT_WAITING_MS) ??
    loadNight(data, start, date).then((value) => ({ at: nowMs, start, value }));
  const activityJob =
    usable(previous?.activity, ACTIVITY_FRESH_MS, gen) ??
    loadActivity(data, start, date).then((value) => ({ at: nowMs, start, gen, value }));
  const [night, activity, minutes, steps5, kcal] = await Promise.all([
    nightJob,
    activityJob,
    minutesJob,
    stepsJob,
    kcalJob,
  ]);
  const schedule = scheduleOf(env);
  const heart = await data.heartBuckets(
    heartFrom,
    date,
    now,
    isToday && minutes.length ? bucketsFromMinutes(minutes, from) : undefined,
  );
  const fetched = InsightsData.merge(start, date, night.value.rows, activity.value.rows);
  const last = fetched[fetched.length - 1];
  if (isToday && last) {
    const live = [...steps5.values()].reduce((a, v) => a + v, 0);
    if (steps5.size) last.steps = Math.max(last.steps ?? 0, live);
    if (kcal !== undefined) last.calories = kcal;
  }
  const detail = { stepsByHour: stepsByHour(steps5, from), ...activity.value.extras };
  const all = fetched.filter((d) => d.date >= firstDay);
  const i = all.length - 1;
  const day = all[i] as Day;

  const asleep = all.flatMap((d) =>
    d.sleep ? [[d.sleep.startMs, d.sleep.endMs] as [number, number]] : [],
  );
  // Each day uses the resting HR known on that day, so past strain never shifts later.
  const restingOn = (k: number) =>
    baseline(all.slice(Math.max(0, k - 29), k + 1).map(sleepRhr))?.mean ?? 65;
  const loads = all.map((d, k) =>
    heart.has(d.date)
      ? trimp(heart.get(d.date), dayStart(d.date), restingOn(k), hrMax, asleep)
      : undefined,
  );
  const sleepScores = all.map((d) =>
    d.sleep
      ? sleepScore(
          d.sleep,
          d.sleepHr,
          sleepRhr(d),
          shareBelowResting(d.sleep, heart, dayStart, sleepRhr(d)),
        )
      : undefined,
  );
  const scores = sleepScores.map((s) => s?.score);
  const ready = all.map((_, k) => readiness(all, k, scores));
  const loadNow = loadBalance(loads);
  const resilient = resilience(all, i, 'ratio' in loadNow ? loadNow.ratio : undefined);

  const tonight = planNight(schedule, addDays(date, 1));
  const whoop = await buildWhoop({
    data,
    all,
    heart,
    minutes,
    dayStart,
    age,
    isToday,
    tonight,
    steps: steps5,
    hrv: night.value.hrv,
  });
  const whoopStrain = (j: number) => whoop.series[j]?.strain;
  const window = all.slice(-span);
  const offset = all.length - window.length;
  const rows = window.map((d, k) => {
    const j = offset + k;
    const load = loads[j];
    const w = whoop.series[j];
    return {
      date: d.date,
      readiness: ready[j]?.score,
      recovery: w?.recovery.score,
      sleepPerformance: w?.sleep.performance,
      sleepNeedMin: w?.sleep.needMin,
      sleepScore: scores[j],
      strain: load === undefined ? undefined : whoopStrain(j),
      asleepMin: d.sleep?.asleep,
      napMin: d.sleep?.napMin || undefined,
      bedtime: d.sleep?.bedtime,
      wake: d.sleep?.wake,
      deepMin: d.sleep?.deep,
      remMin: d.sleep?.rem,
      rhr: sleepRhr(d),
      sleepingHr: d.sleepHr,
      hrv: d.hrv,
      breathing: d.breathing,
      spo2: d.spo2,
      skinTemp: d.skinTemp,
      steps: d.steps,
      zoneMinutes: d.azm,
      calories: d.calories,
      workouts: d.exercises.map((e) => `${e.name} ${e.minutes} min`),
      partial: isToday && j === i,
    };
  });
  const last30 = all.slice(-30);
  const complete = (isToday ? all.slice(0, -1) : all).slice(-30);
  const lastNight = planNight(schedule, date);
  const todayReady = ready[i];
  const dayFlags = flags(all, i);
  const nowMinute = toMinute(toLocalTimeString(Date.now()).slice(0, 5)) % 1440;
  const profile = sleepProfile(last30);

  const report = {
    generatedAt: new Date().toISOString(),
    date,
    realAge: age,
    isToday,
    calibration: calibration(all),
    today: {
      guidance: guidance({
        readiness: todayReady && 'band' in todayReady ? (todayReady as Score) : undefined,
        day,
        isToday,
        now: nowMinute,
        lastNight,
        tonight,
        flags: dayFlags,
        debtMin: profile?.sleepDebt7dMinutes,
      }),
      readiness: todayReady,
      sleepPlan: { lastNight, tonight: isToday ? tonight : undefined },
      sleep:
        day.sleep && sleepScores[i]
          ? { ...sleepScores[i], night: day.sleep, detail: night.value.detail }
          : undefined,
      strain: {
        value: whoopStrain(i) ?? 0,
        label: strainLabel(whoopStrain(i) ?? 0),
        load: loads[i],
        zones: day.zones,
      },
      resilience: resilient,
      load: loadNow,
      vitals: {
        restingHr: vital(all, i, sleepRhr, 'bpm'),
        hrv: {
          ...vital(all, i, (d) => d.hrv, 'ms'),
          typicalForAge: age === undefined ? undefined : round1(hrvNorm(age)),
        },
        sleepingHr: vital(all, i, (d) => d.sleepHr, 'bpm'),
        breathing: vital(all, i, (d) => d.breathing, '/min'),
        spo2: vital(all, i, (d) => d.spo2, '%'),
        skinTemp: vital(all, i, (d) => d.skinTemp, '°C'),
      },
      activity: {
        steps: day.steps,
        zoneMinutes: day.azm,
        activeMinutes: day.activeMinutes,
        calories: day.calories,
        workouts: day.exercises,
        stepsByHour: detail.stepsByHour,
        distanceKm: detail.distanceKm,
        sedentary: detail.sedentary,
      },
      cardioFitness: {
        vo2Max: day.vo2 ?? baseline(all.map((d) => d.vo2))?.mean,
        estimate:
          age === undefined
            ? undefined
            : estimatedVo2(baseline(all.slice(-7).map(sleepRhr))?.mean, age),
      },
      flags: dayFlags,
    },
    bodyAge:
      age === undefined
        ? undefined
        : bodyAge({
            days: last30,
            complete,
            age,
            regularity: sleepRegularity(last30, dayStart),
          }),
    sleepProfile: profile,
    whoop: whoop.today,
    trends: trendsOf(rows, span),
    dataStart: all.find((d) => d.rhr !== undefined || d.sleep)?.date,
  };
  return { report, tiers: { night, activity } satisfies Tiers };
}
