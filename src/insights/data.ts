import type { Env } from '../env';
import { cacheGeneration, getCached } from '../lib/cache';
import { localDayStartUtc, today } from '../lib/date';
import { addDays, GoogleHealthClient } from '../providers/google-health/client';
import { dayRangeFilter } from '../providers/google-health/filters';
import { durationMs, fromCivilDate, num } from '../providers/google-health/map';
import { briefWakeMinutes, nightsByDate, type SleepRecord, segments, stageTotals } from './sleep';
import type {
  Day,
  DayDetail,
  Exercise,
  HeartBuckets,
  NightDetail,
  SleepNight,
  Zones,
} from './types';
import type { HrPoint } from './whoop';

type Row = Record<string, unknown>;
/** Part of each day's data, by date, as stored between builds. */
export type Rows = Array<[string, Partial<Day>]>;
export type HrvSample = { ms: number; rmssd: number };
export type CycleLoad = { load: number; zones: number[] };

const HOUR = 3_600_000;
const BUCKET_MS = 300_000;
const HR_FIELDS = 'rollupDataPoints(startTime,heartRate/beatsPerMinuteAvg),nextPageToken';
const HR_CACHE_TTL_SEC = 90 * 86_400;
const PAST_EXERCISE_TTL_SEC = 3 * 3600;
/** Bumped when a workout is saved, so the past-workout cache picks it up. */
export const EXERCISE_CACHE_GROUP = 'insights_exercise';
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const SLEEP_FIELDS =
  'dataPoints(dataSource(platform),sleep(interval,summary,metadata,stages)),nextPageToken';
const CYCLE_TTL_SEC = 120 * 86_400;

function offsetSec(v: unknown): number {
  return (durationMs(v) ?? 0) / 1000;
}

function localParts(iso: string, offset: unknown) {
  const d = new Date(Date.parse(iso) + offsetSec(offset) * 1000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date: d.toISOString().slice(0, 10), clock: d.toISOString().slice(11, 16), minute };
}

function emptyDay(date: string): Day {
  return { date, exercises: [] };
}

function dates(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function zonesFrom(list: unknown, key: string, value: (z: Row) => number): Zones {
  const zones: Zones = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  for (const z of (list as Row[] | undefined) ?? []) {
    const name = String(z[key]).toLowerCase() as keyof Zones;
    if (name in zones) zones[name] += value(z);
  }
  return zones;
}

export class InsightsData {
  private readonly client: GoogleHealthClient;

  constructor(private readonly env: Env) {
    this.client = new GoogleHealthClient(env);
  }

  /** Five-minute heart rate per day. Finished days are cached, so each day is fetched once. */
  async heartBuckets(
    start: string,
    end: string,
    today: string,
    todayList?: HeartBuckets,
  ): Promise<Map<string, HeartBuckets>> {
    const out = new Map<string, HeartBuckets>();
    const missing: string[] = [];
    await Promise.all(
      dates(start, end).map(async (d) => {
        if (d === today && todayList) return void out.set(d, todayList);
        const hit =
          d < today ? await this.env.CACHE.get<HeartBuckets>(`hr5:v1:${d}`, 'json') : null;
        if (hit) out.set(d, hit);
        else missing.push(d);
      }),
    );
    missing.sort();
    const runs: string[][] = [];
    for (const d of missing) {
      const run = runs[runs.length - 1];
      if (run && addDays(run[run.length - 1] as string, 1) === d && run.length < 14) run.push(d);
      else runs.push([d]);
    }
    for (const run of runs) {
      const last = run[run.length - 1] as string;
      const starts = run.map((d) => localDayStartUtc(d).getTime());
      const from = starts[0] as number;
      const to = Math.min(localDayStartUtc(addDays(last, 1)).getTime(), Date.now());
      const filled = new Map(run.map((d) => [d, new Array<number | null>(300).fill(null)]));
      if (to > from) {
        const rows = await this.client.rollUp('heart-rate', iso(from), iso(to), '300s', HR_FIELDS);
        for (const row of rows) {
          const ms = Date.parse(String(row.startTime));
          const avg = num((row.heartRate as Row | undefined)?.beatsPerMinuteAvg);
          if (!Number.isFinite(ms) || avg === undefined) continue;
          let k = starts.length - 1;
          while (k > 0 && ms < (starts[k] as number)) k -= 1;
          const list = filled.get(run[k] as string);
          if (list && ms >= (starts[k] as number)) {
            list[Math.floor((ms - (starts[k] as number)) / BUCKET_MS)] = Math.round(avg);
          }
        }
      }
      for (const [d, list] of filled) {
        out.set(d, list);
        if (d < today) {
          await this.env.CACHE.put(`hr5:v1:${d}`, JSON.stringify(list), {
            expirationTtl: HR_CACHE_TTL_SEC,
          });
        }
      }
    }
    return out;
  }

  async stepsBy5Min(from: number, to: number): Promise<Map<number, number>> {
    if (to <= from) return new Map();
    const rows = await this.client.rollUp('steps', iso(from), iso(to), '300s');
    return new Map(
      rows.map((r) => [
        Date.parse(String(r.startTime)),
        num((r.steps as Row | undefined)?.countSum) ?? 0,
      ]),
    );
  }

  async minuteHr(from: number, to: number): Promise<HrPoint[]> {
    if (to <= from) return [];
    const rows = await this.client.rollUp('heart-rate', iso(from), iso(to), '60s', HR_FIELDS);
    return rows
      .map((r) => ({
        ms: Date.parse(String(r.startTime)),
        bpm: Math.round(num((r.heartRate as Row | undefined)?.beatsPerMinuteAvg) ?? 0),
        min: 1,
      }))
      .filter((p) => Number.isFinite(p.ms) && p.bpm > 0)
      .sort((a, b) => a.ms - b.ms);
  }

  async hrvSamples(from: number, to: number): Promise<HrvSample[]> {
    const rows = await this.client.listAll('heart-rate-variability', {
      filter: `heart_rate_variability.sample_time.physical_time >= "${iso(from)}" AND heart_rate_variability.sample_time.physical_time < "${iso(to)}"`,
      pageSize: 1000,
    });
    return (rows as Row[])
      .map((r) => r.heartRateVariability as Row)
      .map((h) => ({
        ms: Date.parse(String((h?.sampleTime as Row | undefined)?.physicalTime)),
        rmssd: num(h?.rootMeanSquareOfSuccessiveDifferencesMilliseconds) ?? 0,
      }))
      .filter((h) => Number.isFinite(h.ms) && h.rmssd > 0);
  }

  async caloriesOn(date: string): Promise<number | undefined> {
    const [row] = await this.client.dailyRollUp('total-calories', date, date);
    const kcal = num(((row?.totalCalories ?? {}) as Row).kcalSum);
    return kcal === undefined ? undefined : Math.round(kcal);
  }

  /** Strain load of a finished Whoop day, kept so each one is worked out from minutes once. */
  async cycleLoad(
    window: [number, number],
    measure?: (points: HrPoint[]) => CycleLoad,
  ): Promise<CycleLoad | undefined> {
    const key = `wcyc:v1:${window[0]}:${window[1]}`;
    const hit = await this.env.CACHE.get<CycleLoad>(key, 'json');
    if (hit || !measure) return hit ?? undefined;
    const result = measure(await this.minuteHr(window[0], window[1]));
    await this.env.CACHE.put(key, JSON.stringify(result), { expirationTtl: CYCLE_TTL_SEC });
    return result;
  }

  private async daily(type: string, start: string, end: string): Promise<Row[]> {
    const rows = await this.client.listAll(type, {
      filter: dayRangeFilter(type, 'daily', start, end),
      pageSize: 1000,
    });
    const key = type.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    return (rows as Row[]).map((r) => (r[key] ?? {}) as Row);
  }

  private async rollup(type: string, start: string, end: string, capDays: number) {
    const out: Row[] = [];
    for (let from = start; from <= end; from = addDays(from, capDays)) {
      const to = addDays(from, capDays - 1) < end ? addDays(from, capDays - 1) : end;
      out.push(...(await this.client.dailyRollUp(type, from, to)));
    }
    return out.map((r) => ({
      date: fromCivilDate((r.civilStartTime as Row | undefined)?.date) ?? '',
      value: (r[type.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())] ?? {}) as Row,
    }));
  }

  static merge(start: string, end: string, ...parts: Rows[]): Day[] {
    const byDate = new Map(dates(start, end).map((d) => [d, emptyDay(d)]));
    for (const rows of parts) {
      for (const [date, part] of rows) {
        const day = byDate.get(date);
        if (day) Object.assign(day, part);
      }
    }
    return [...byDate.values()];
  }

  /** Vitals and sleep, which change about once a night. */
  async nightRows(start: string, end: string): Promise<Rows> {
    const byDate = new Map<string, Partial<Day>>();
    const at = (date: string | undefined) => {
      if (!date || date < start || date > end) return undefined;
      const day = byDate.get(date) ?? {};
      byDate.set(date, day);
      return day;
    };
    // Sleep goes first: it pages, and the Worker queues requests past six at a time.
    const sleepJob = this.client.listAll('sleep', {
      filter: dayRangeFilter('sleep', 'interval', start, end),
      pageSize: 25,
      fields: SLEEP_FIELDS,
    });
    const [rhr, hrv, resp, spo2, temp, vo2, sleep] = await Promise.all([
      this.daily('daily-resting-heart-rate', start, end),
      this.daily('daily-heart-rate-variability', start, end),
      this.daily('daily-respiratory-rate', start, end),
      this.daily('daily-oxygen-saturation', addDays(start, -1), addDays(end, -1)),
      this.daily('daily-sleep-temperature-derivations', start, end),
      this.daily('daily-vo2-max', start, end),
      sleepJob,
    ]);

    for (const r of rhr) {
      const day = at(fromCivilDate(r.date));
      if (!day) continue;
      day.rhr = num(r.beatsPerMinute);
      const meta = (r.dailyRestingHeartRateMetadata ?? {}) as Row;
      day.rhrWithSleep = meta.calculationMethod !== 'ONLY_WITH_AWAKE_DATA';
    }
    for (const r of hrv) {
      const day = at(fromCivilDate(r.date));
      if (!day) continue;
      day.hrv = num(r.averageHeartRateVariabilityMilliseconds);
      day.hrvDeep = num(r.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds);
      day.sleepHr = num(r.nonRemHeartRateBeatsPerMinute);
    }
    for (const r of resp) {
      const day = at(fromCivilDate(r.date));
      if (day) day.breathing = num(r.breathsPerMinute);
    }
    for (const r of spo2) {
      const night = fromCivilDate(r.date);
      // Nightly SpO2 is dated by the evening the night began, not the wake-up morning.
      const day = at(night ? addDays(night, 1) : undefined);
      if (!day) continue;
      day.spo2 = num(r.averagePercentage);
      day.spo2Low = num(r.lowerBoundPercentage);
    }
    for (const r of temp) {
      const day = at(fromCivilDate(r.date));
      if (!day) continue;
      const nightly = num(r.nightlyTemperatureCelsius);
      const base = num(r.baselineTemperatureCelsius);
      day.skinTemp = nightly === undefined ? undefined : Number(nightly.toFixed(2));
      if (nightly !== undefined && base !== undefined) {
        day.skinTempDelta = Number((nightly - base).toFixed(2));
      }
    }
    for (const r of vo2) {
      const day = at(fromCivilDate(r.date));
      if (day) day.vo2 = num(r.vo2Max);
    }
    this.applySleep(sleep as Row[], at);
    return [...byDate];
  }

  /** Steps, zones, calories and workouts, which change through the day. */
  async activityRows(start: string, end: string): Promise<Rows> {
    const byDate = new Map<string, Partial<Day>>();
    const at = (date: string | undefined) => {
      if (!date || date < start || date > end) return undefined;
      const day = byDate.get(date) ?? {};
      byDate.set(date, day);
      return day;
    };
    const shortStart = addDays(end, -13) > start ? addDays(end, -13) : start;
    const [exercise, steps, azm, zones, active, kcal] = await Promise.all([
      this.exercises(start, end),
      this.rollup('steps', start, end, 90),
      this.rollup('active-zone-minutes', start, end, 90),
      this.rollup('time-in-heart-rate-zone', start, end, 90),
      this.rollup('active-minutes', shortStart, end, 14),
      this.rollup('total-calories', shortStart, end, 14),
    ]);
    for (const ex of (exercise as Row[]).map((r) => toExercise(r.exercise as Row))) {
      const day = at(ex?.date);
      if (day) day.exercises = [...(day.exercises ?? []), ex as Exercise];
    }
    for (const { date, value } of steps) {
      const day = at(date);
      if (day) day.steps = num(value.countSum);
    }
    for (const { date, value } of azm) {
      const day = at(date);
      if (!day) continue;
      day.azm =
        (num(value.sumInFatBurnHeartZone) ?? 0) +
        2 * (num(value.sumInCardioHeartZone) ?? 0) +
        2 * (num(value.sumInPeakHeartZone) ?? 0);
    }
    for (const { date, value } of zones) {
      const day = at(date);
      if (!day) continue;
      day.zones = zonesFrom(
        value.timeInHeartRateZones,
        'heartRateZone',
        (z) => (durationMs(z.duration) ?? 0) / 60_000,
      );
    }
    for (const { date, value } of active) {
      const day = at(date);
      if (!day) continue;
      const levels = zonesFrom(value.activeMinutesRollupByActivityLevel, 'activityLevel', (z) =>
        Number(z.activeMinutesSum ?? 0),
      );
      day.activeMinutes = {
        light: levels.light,
        moderate: levels.moderate,
        vigorous: levels.vigorous,
      };
    }
    for (const { date, value } of kcal) {
      const day = at(date);
      if (day) day.calories = Math.round(num(value.kcalSum) ?? 0);
    }
    return [...byDate];
  }

  // Google takes about 4 s to list workouts, so finished days are listed once and kept.
  private async exercises(start: string, end: string): Promise<Row[]> {
    const list = (from: string, to: string) =>
      this.client.listAll('exercise', {
        filter: dayRangeFilter('exercise', 'interval', from, to),
        pageSize: 25,
      }) as Promise<Row[]>;
    const now = today();
    const pastEnd = end < now ? end : addDays(now, -1);
    const gen = await cacheGeneration(this.env, EXERCISE_CACHE_GROUP);
    const [past, live] = await Promise.all([
      pastEnd < start
        ? []
        : getCached(this.env, `ex:v1:${gen}:${start}:${pastEnd}`, () => list(start, pastEnd), {
            ttlSec: PAST_EXERCISE_TTL_SEC,
          }),
      end < now ? [] : list(now > start ? now : start, end),
    ]);
    return [...past, ...live];
  }

  private applySleep(
    rows: Row[],
    at: (date: string | undefined) => { sleep?: SleepNight } | undefined,
  ) {
    const records: SleepRecord[] = [];
    for (const row of rows) {
      const s = (row.sleep ?? {}) as Row;
      const interval = (s.interval ?? {}) as Row;
      const summary = (s.summary ?? {}) as Row;
      const meta = (s.metadata ?? {}) as Row;
      const startIso = String(interval.startTime ?? '');
      const endIso = String(interval.endTime ?? '');
      if (!startIso || !endIso) continue;
      const end = localParts(endIso, interval.endUtcOffset);
      if (!at(end.date)) continue;
      const start = localParts(startIso, interval.startUtcOffset);
      const totals = stageTotals(summary);
      const brief = Math.min(totals.awake, briefWakeMinutes(s.stages));
      records.push({
        date: end.date,
        main: meta.nap !== true && meta.mainSleep !== false,
        night: {
          bedtime: start.clock,
          wake: end.clock,
          startMs: Date.parse(startIso),
          endMs: Date.parse(endIso),
          bedMinute: start.minute,
          wakeMinute: end.minute,
          asleep: totals.asleep + brief,
          inBed: num(summary.minutesInSleepPeriod) ?? 0,
          awake: totals.awake - brief,
          wakeUps: totals.wakeUps,
          deep: totals.deep,
          rem: totals.rem,
          light: totals.light,
          latency: num(summary.minutesToFallAsleep),
          naps: 0,
          napMin: 0,
        },
      });
    }
    for (const [date, night] of nightsByDate(records)) {
      const day = at(date);
      if (day) day.sleep = night;
    }
  }

  async night(date: string, night: SleepNight): Promise<NightDetail> {
    const from = new Date(night.startMs).toISOString();
    const to = new Date(night.endMs).toISOString();
    const [sleepRows, hr, spo2Rows, breath] = await Promise.all([
      this.client.listAll('sleep', {
        filter: dayRangeFilter('sleep', 'interval', addDays(date, -1), date),
        pageSize: 25,
      }),
      this.client.rollUp('heart-rate', from, to, '600s'),
      this.client.listAll('oxygen-saturation', {
        filter: `oxygen_saturation.sample_time.physical_time >= "${from.replace(/\.\d+Z$/, 'Z')}" AND oxygen_saturation.sample_time.physical_time < "${to.replace(/\.\d+Z$/, 'Z')}"`,
        pageSize: 2000,
      }),
      this.client.listAll('respiratory-rate-sleep-summary', {
        filter: `respiratory_rate_sleep_summary.sample_time.physical_time >= "${iso(night.endMs - 3 * HOUR)}" AND respiratory_rate_sleep_summary.sample_time.physical_time < "${iso(night.endMs + 3 * HOUR)}"`,
        pageSize: 10,
      }),
    ]);

    const parts: Row[] = [];
    const edge = (s: Row, k: 'startTime' | 'endTime') =>
      Date.parse(String((s.interval as Row)?.[k]));
    for (const s of (sleepRows as Row[])
      .map((r) => r.sleep as Row)
      .filter((s) => edge(s, 'startTime') >= night.startMs && edge(s, 'endTime') <= night.endMs)
      .sort((a, b) => edge(a, 'startTime') - edge(b, 'startTime'))) {
      const prev = parts[parts.length - 1];
      if (!prev || edge(s, 'startTime') >= edge(prev, 'endTime')) parts.push(s);
    }
    const offset = (parts[0]?.interval as Row | undefined)?.startUtcOffset;
    const between = parts.slice(1).map((s, k) => ({
      stage: 'awake',
      startMs: edge(parts[k] as Row, 'endTime'),
      endMs: edge(s, 'startTime'),
    }));
    const timeline = [
      ...segments(parts.flatMap((s) => (s.stages as Row[] | undefined) ?? [])),
      ...between.filter((g) => g.endMs > g.startMs),
    ].sort((a, b) => a.startMs - b.startMs);
    const stages = timeline.map((st) => ({
      stage: st.stage,
      start: localParts(new Date(st.startMs).toISOString(), offset).clock,
      offset: round1((st.startMs - night.startMs) / 60_000),
      minutes: round1((st.endMs - st.startMs) / 60_000),
    }));

    const heartRate = hr
      .map((b) => {
        const v = (b.heartRate ?? {}) as Row;
        return {
          t: localParts(String(b.startTime), offset).clock,
          ms: Date.parse(String(b.startTime)),
          offset: round1((Date.parse(String(b.startTime)) - night.startMs) / 60_000),
          avg: Math.round(num(v.beatsPerMinuteAvg) ?? 0),
          min: num(v.beatsPerMinuteMin) ?? 0,
          max: num(v.beatsPerMinuteMax) ?? 0,
        };
      })
      .sort((a, b) => a.ms - b.ms)
      .map(({ ms: _ms, ...rest }) => rest);

    const samples = (spo2Rows as Row[])
      .map((r) => r.oxygenSaturation as Row)
      .map((s) => ({
        ms: Date.parse(String((s.sampleTime as Row)?.physicalTime)),
        v: num(s.percentage) ?? 0,
      }))
      .filter((s) => s.v > 0)
      .sort((a, b) => a.ms - b.ms);
    const values = samples.map((s) => s.v);
    const gaps = samples.map((s, i) =>
      i === 0 ? 1 : Math.min(5, (s.ms - samples[i - 1]!.ms) / 60_000),
    );

    const nearest = (breath as Row[])
      .map((r) => r.respiratoryRateSleepSummary as Row)
      .map((r) => ({
        r,
        gap: Math.abs(Date.parse(String((r.sampleTime as Row)?.physicalTime)) - night.endMs),
      }))
      .sort((x, y) => x.gap - y.gap)[0];
    const b = (nearest?.r ?? {}) as Row;
    const coverage = Math.min(1, samples.length / Math.max(1, night.asleep));
    const rate = (k: string) => {
      const v = num((b[k] as Row | undefined)?.breathsPerMinute);
      return v && v > 0 ? v : undefined;
    };

    return {
      stages,
      heartRate,
      spo2: {
        avg:
          coverage >= 0.5 ? round1(values.reduce((a, v) => a + v, 0) / values.length) : undefined,
        min: values.length ? Math.min(...values) : undefined,
        coverage: Math.round(coverage * 100),
        minutesBelow90: Math.round(
          samples.reduce((a, s, i) => a + (s.v < 90 ? (gaps[i] ?? 1) : 0), 0),
        ),
        samples: thin(samples, 60).map((s) => ({
          t: localParts(new Date(s.ms).toISOString(), offset).clock,
          v: s.v,
          offset: round1((s.ms - night.startMs) / 60_000),
        })),
      },
      breathingByStage: {
        light: rate('lightSleepStats'),
        deep: rate('deepSleepStats'),
        rem: rate('remSleepStats'),
        full: rate('fullSleepStats'),
      },
    };
  }

  /** Sitting time and distance, which come with the slower daytime data. */
  async dayExtras(date: string): Promise<Omit<DayDetail, 'stepsByHour'>> {
    const [sedentary, distance] = await Promise.all([
      this.client.listAll('sedentary-period', {
        filter: dayRangeFilter('sedentary-period', 'interval', date, date),
        pageSize: 1000,
      }),
      this.client.dailyRollUp('distance', date, date).catch(() => []),
    ]);
    const mm = num(((distance[0]?.distance ?? {}) as Row).millimetersSum);
    const lengths = (sedentary as Row[]).map((r) => {
      const i = ((r.sedentaryPeriod as Row)?.interval ?? {}) as Row;
      return (Date.parse(String(i.endTime)) - Date.parse(String(i.startTime))) / 60_000;
    });
    return {
      distanceKm: mm === undefined ? undefined : round1(mm / 1_000_000),
      sedentary: {
        minutes: Math.round(lengths.reduce((a, v) => a + v, 0)),
        longest: Math.round(Math.max(0, ...lengths)),
        stretches: lengths.filter((v) => v >= 60).length,
      },
    };
  }
}

export function stepsByHour(
  fiveMin: Map<number, number>,
  dayStartMs: number,
): DayDetail['stepsByHour'] {
  const hours = new Map<number, number>();
  for (const [ms, v] of fiveMin) {
    const h = Math.floor((ms - dayStartMs) / HOUR);
    if (h >= 0 && h < 24) hours.set(h, (hours.get(h) ?? 0) + v);
  }
  return [...hours].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({ t: String(h), v }));
}

function toExercise(e: Row | undefined): Exercise | undefined {
  if (!e) return undefined;
  const interval = (e.interval ?? {}) as Row;
  const m = (e.metricsSummary ?? {}) as Row;
  const start = localParts(String(interval.startTime), interval.startUtcOffset);
  const z = (m.heartRateZoneDurations ?? {}) as Row;
  const mins = (v: unknown) => Math.round((durationMs(v) ?? 0) / 60_000);
  return {
    date: start.date,
    name: String(e.displayName ?? e.exerciseType ?? 'Exercise'),
    type: String(e.exerciseType ?? ''),
    start: start.clock,
    startMs: Date.parse(String(interval.startTime)),
    endMs: Date.parse(String(interval.endTime)),
    minutes: mins(e.activeDuration),
    avgHr: num(m.averageHeartRateBeatsPerMinute),
    azm: num(m.activeZoneMinutes),
    calories: num(m.caloriesKcal),
    steps: num(m.steps),
    zones: {
      light: mins(z.lightTime),
      moderate: mins(z.moderateTime),
      vigorous: mins(z.vigorousTime),
      peak: mins(z.peakTime),
    },
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)] as T);
}
