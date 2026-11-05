import { addDays } from '../providers/google-health/client';
import type { HrvSample, InsightsData } from './data';
import type { NightPlan } from './schedule';
import { baseline, round1, sleepRhr, strainLabel } from './scores';
import type { Day, HeartBuckets, SleepNight } from './types';
import {
  AGE_NIGHTS,
  bucketPoints,
  type HrPoint,
  sleepHrv,
  sleepNeed,
  sleepPlanner,
  sleepStress,
  strainLoad,
  strainTarget,
  stressMonitor,
  whoopDays,
  whoopHrMax,
  whoopRhr,
  whoopStrain,
  withDetail,
  zoneMinutes,
} from './whoop';

const BACKFILL_PER_BUILD = 3;
const HISTORY_ROWS = 30;

export type HrvNight = { samples: HrvSample[]; lnMean: number; lnSpread: number };

/** Last night's HRV samples with the spread of the week before, for Whoop's sleep stress. */
export function hrvNight(samples: HrvSample[], night: SleepNight): HrvNight {
  const inside = samples.filter((s) => s.ms >= night.startMs && s.ms < night.endMs);
  const earlier = samples.filter((s) => s.ms < night.startMs);
  const ln = (earlier.length >= 30 ? earlier : samples).map((s) => Math.log(s.rmssd));
  const lnMean = ln.reduce((a, b) => a + b, 0) / Math.max(1, ln.length);
  const sd = Math.sqrt(ln.reduce((a, b) => a + (b - lnMean) ** 2, 0) / Math.max(1, ln.length - 1));
  return { samples: inside, lnMean, lnSpread: Math.max(sd, 0.1) };
}

/** Five-minute averages for one local day, from one-minute heart rate. */
export function bucketsFromMinutes(points: HrPoint[], dayStart: number): HeartBuckets {
  const sums = new Array<number>(288).fill(0);
  const counts = new Array<number>(288).fill(0);
  for (const p of points) {
    const k = Math.floor((p.ms - dayStart) / 300_000);
    if (k < 0 || k >= 288) continue;
    sums[k] = (sums[k] ?? 0) + p.bpm;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return sums.map((s, k) => (counts[k] ? Math.round(s / (counts[k] as number)) : null));
}

const inWindow = (points: HrPoint[], from: number, to: number) =>
  points.filter((p) => p.ms >= from && p.ms < to);

const avg = (xs: Array<number | undefined>) => baseline(xs)?.mean;

export async function buildWhoop(input: {
  data: InsightsData;
  all: Day[];
  heart: Map<string, HeartBuckets>;
  minutes: HrPoint[];
  dayStart: (date: string) => number;
  age?: number;
  isToday: boolean;
  tonight: NightPlan;
  steps: Map<number, number>;
  hrv?: HrvNight;
}) {
  const { data, all, heart, minutes, dayStart, age, isToday, tonight, steps } = input;
  const i = all.length - 1;
  const day = all[i] as Day;
  const now = Date.now();
  // Without BIRTH_DATE there is no age, so use a neutral max-HR estimate.
  const hrMax = age === undefined ? 180 : whoopHrMax(age);
  const resting = (k: number) =>
    baseline(all.slice(Math.max(0, k - 29), k + 1).map(whoopRhr))?.mean ?? 60;
  const five = (k: number) =>
    [k - 1, k, k + 1].flatMap((j) => {
      const d = all[j];
      return d ? bucketPoints(heart.get(d.date), dayStart(d.date)) : [];
    });
  // Whoop's day runs from falling asleep to the next sleep, so last night counts towards today.
  const cycle = (k: number): [number, number] => {
    const d = all[k] as Day;
    const end = k === i && isToday ? now : dayStart(addDays(d.date, 1));
    return [d.sleep?.startMs ?? dayStart(d.date), all[k + 1]?.sleep?.startMs ?? end];
  };
  const detail = minutes.length
    ? [
        {
          from: (minutes[0] as HrPoint).ms,
          to: (minutes.at(-1) as HrPoint).ms + 60_000,
          points: minutes,
        },
      ]
    : [];
  const points = withDetail(five(i), detail);
  const measure = (pts: HrPoint[], k: number, window: [number, number]) => ({
    load: strainLoad(pts, resting(k), hrMax, window),
    zones: zoneMinutes(inWindow(pts, window[0], window[1]), resting(k), hrMax),
  });

  const loads: Array<number | undefined> = all.map(() => undefined);
  loads[i] = heart.has(day.date) ? measure(points, i, cycle(i)).load : undefined;
  const done = all.map((d, k) => k < i && heart.has(d.date) && !!all[k + 1]?.sleep);
  const cached = await Promise.all(
    all.map((_, k) => (done[k] ? data.cycleLoad(cycle(k)) : undefined)),
  );
  const missing = all.map((_, k) => k).filter((k) => done[k] && !cached[k]);
  await Promise.all(
    missing.slice(-BACKFILL_PER_BUILD).map(async (k) => {
      cached[k] = await data
        .cycleLoad(cycle(k), (pts) => measure(pts, k, cycle(k)))
        .catch(() => undefined);
    }),
  );
  all.forEach((d, k) => {
    if (k === i || !heart.has(d.date)) return;
    loads[k] = cached[k]?.load ?? measure(five(k), k, cycle(k)).load;
  });
  const strains = loads.map((l) => (l === undefined ? undefined : whoopStrain(l)));
  const series = whoopDays(all, strains);
  const w = series[i];
  if (!w) return { series, today: undefined };

  const rhr = resting(i);
  const [from, to] = cycle(i);
  const inCycle = inWindow(points, from, to);
  const activities = day.exercises.map((e) => {
    const pts = inWindow(points, e.startMs, e.endMs);
    return {
      name: e.name,
      type: e.type,
      start: e.start,
      startMs: e.startMs,
      endMs: e.endMs,
      minutes: e.minutes,
      strain: whoopStrain(strainLoad(pts, rhr, hrMax)),
      avgHr: e.avgHr,
      maxHr: pts.length ? Math.max(...pts.map((p) => p.bpm)) : undefined,
      calories: e.calories,
      zones: zoneMinutes(pts, rhr, hrMax),
    };
  });

  const start = dayStart(day.date);
  const night = day.sleep;
  const skip: Array<[number, number]> = [
    ...all.flatMap((d) => (d.sleep ? [[d.sleep.startMs, d.sleep.endMs] as [number, number]] : [])),
    ...day.exercises.map((e) => [e.startMs, e.endMs] as [number, number]),
  ];
  const stress = stressMonitor(bucketPoints(heart.get(day.date), start), steps, rhr, hrMax, skip);
  const hrv = input.hrv;
  const stressPct =
    night && hrv
      ? sleepStress(hrv.samples, points, hrv.lnMean, hrv.lnSpread, rhr, hrMax)
      : undefined;

  const next = sleepNeed(w.strain, w.debtAfter, night?.napMin ?? 0);
  const efficiencies = series.flatMap((x) =>
    x.sleep.efficiency === undefined ? [] : [x.sleep.efficiency],
  );
  const nights = all.slice(-31).filter((d) => d.hrv !== undefined).length;
  const prior = all.slice(Math.max(0, i - 30), i);
  const whole = isToday ? prior : all.slice(Math.max(0, i - 29), i + 1);
  const cycleBpm = inCycle.map((p) => p.bpm);
  const rec = w.recovery;

  return {
    series,
    today: {
      recovery: rec,
      sleep: {
        ...w.sleep,
        stressPct,
        bedtime: night?.bedtime,
        wake: night?.wake,
        inBedMin: night?.inBed,
        awakeMin: night?.awake,
        disturbances: night?.wakeUps,
        latencyMin: night?.latency,
        stages: night
          ? { awake: night.awake, light: night.light, deep: night.deep, rem: night.rem }
          : undefined,
        napMin: night?.napMin || undefined,
      },
      strain: {
        value: w.strain ?? 0,
        label: strainLabel(w.strain ?? 0),
        target: strainTarget(rec.score === undefined || rec.calibrating ? undefined : rec.band),
        zones: zoneMinutes(inCycle, rhr, hrMax),
        calories: day.calories,
        steps: day.steps,
        activities,
        hrMax: Math.round(hrMax),
        restingHr: Math.round(rhr),
        avgHr: cycleBpm.length
          ? Math.round(cycleBpm.reduce((a, b) => a + b, 0) / cycleBpm.length)
          : undefined,
        maxHr: cycleBpm.length ? Math.max(...cycleBpm) : undefined,
        heartRate: heart.get(day.date) ?? [],
        from,
        to,
      },
      stress: {
        levels: stress.series.map(
          (s) => [Math.round((s.ms - start) / 300_000), s.v] as [number, number | null],
        ),
        average: stress.average,
        current: isToday ? stress.current : undefined,
        calm: stress.calm,
        neutral: stress.neutral,
        high: stress.high,
      },
      tonight: isToday
        ? {
            ...next,
            wake: tonight.wake,
            early: tonight.early,
            planner: sleepPlanner(next.needMin, tonight, efficiencies),
          }
        : undefined,
      // Each figure against the 30 days before it, as Whoop's dashboard shows them.
      stats: {
        hrv: { value: sleepHrv(day), average: avg(prior.map(sleepHrv)), google: day.hrv },
        restingHr: {
          value: whoopRhr(day),
          average: avg(prior.map(whoopRhr)),
          google: sleepRhr(day),
        },
        breathing: { value: day.breathing, average: avg(prior.map((d) => d.breathing)) },
        spo2: { value: day.spo2, average: avg(prior.map((d) => d.spo2)) },
        skinTemp: { value: day.skinTempDelta, average: 0 },
        asleep: { value: night?.asleep, average: avg(prior.map((d) => d.sleep?.asleep)) },
        steps: { value: day.steps, average: avg(whole.map((d) => d.steps)) },
        calories: { value: day.calories, average: avg(whole.map((d) => d.calories)) },
        vo2: { value: day.vo2 ?? avg(all.map((d) => d.vo2)), average: undefined },
      },
      history: series.slice(-HISTORY_ROWS).map((x, k) => {
        const d = all[all.length - Math.min(HISTORY_ROWS, series.length) + k] as Day;
        return {
          date: x.date,
          recovery: x.recovery.score,
          band: x.recovery.score === undefined ? undefined : x.recovery.band,
          sleep: x.sleep.performance,
          asleepMin: x.sleep.asleepMin,
          needMin: x.sleep.needMin,
          strain: x.strain,
          hrv: sleepHrv(d) === undefined ? undefined : round1(sleepHrv(d) as number),
          rhr: whoopRhr(d),
          partial: isToday && x.date === day.date,
        };
      }),
      age: { nights, needed: AGE_NIGHTS, unlocked: nights >= AGE_NIGHTS },
    },
  };
}

export type WhoopToday = NonNullable<Awaited<ReturnType<typeof buildWhoop>>['today']>;
