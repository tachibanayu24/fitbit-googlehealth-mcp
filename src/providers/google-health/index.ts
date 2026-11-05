import type { Env } from '../../env';
import { getCached } from '../../lib/cache';
import {
  localDayStartUtc,
  localTimeToUtcMs,
  parseZonedIso,
  today,
  toLocalDateString,
  zoneOffsetMs,
} from '../../lib/date';
import { UnsupportedOperationError } from '../../lib/errors';
import type {
  ActivityResourceT,
  BodyFatLog,
  BodyLog,
  CardioFitness,
  DailySummary,
  Device,
  ExerciseHeartRate,
  ExerciseHrOptions,
  ExerciseListOptions,
  ExerciseLog,
  ExerciseRef,
  FoodLog,
  FoodLogEntry,
  HealthProvider,
  HeartRateDay,
  HeartRateIntraday,
  HeartRateSeries,
  HeartRateZone,
  HrResolutionT,
  HrvDay,
  IntradayDetailLevelT,
  IntradayWindow,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  LogWorkoutInput,
  Profile,
  RespiratoryRateDay,
  SkinTempDay,
  SleepLog,
  SpO2Day,
  TimeSeries,
  TimeWindow,
  WaterLogEntry,
  WeightLog,
  ZoneBasis,
} from '../types';
import { addDays, GoogleHealthClient, maxPageSize, rollupRangeCapDays } from './client';
import { dayRangeFilter, filterPath, type TimeField } from './filters';
import {
  bucketize,
  customZones,
  HR_FIELDS,
  type HrSample,
  type HrZone,
  isoLocal,
  isoUtc,
  karvonenZones,
  parseHrRows,
  percentMaxZones,
  RESOLUTION_SEC,
  sliceByTime,
  summarize,
  timeInZones,
} from './hr-series';
import {
  durationMs,
  fromCivilDate,
  GOOGLE_TO_MEAL_TYPE_ID,
  kebabToCamel,
  MEAL_TYPE_TO_GOOGLE,
  NUTRIENT,
  nameToNumericId,
  num,
  pointDate,
  pointTimestamp,
  SLEEP_STAGE_TO_LEVEL,
} from './map';
import { analyzeSegments, parsePlan, pausesFromEvents } from './segments';

type Row = Record<string, unknown>;

/** Heart-rate listings are split into windows of this size (see heartRateSamples). */
const HR_CHUNK_MS = 2 * 3_600_000;
/** How many heart-rate windows are fetched at the same time. */
const HR_CONCURRENCY = 4;
/** Longest window one series request may cover. */
const MAX_SERIES_MS = 24 * 3_600_000;
/** How far back exercise lookups go when no date is given. */
const EXERCISE_LOOKBACK_DAYS = 90;
/** Longest `from`..`to` window for the exercise list; keeps it under the page cap. */
const MAX_EXERCISE_RANGE_DAYS = 180;
/** Exercise ids are opaque tokens; this also blocks path injection. */
const EXERCISE_ID_RE = /^[A-Za-z0-9_-]+$/;
const MIN_WORKOUT_MS = 5 * 60_000;
const MAX_WORKOUT_MS = 4 * 3_600_000;
const CREATE_POLLS = 4;
const CREATE_POLL_MS = 750;

/**
 * Fitbit's activity time-series resources mapped onto Google Health data
 * types, plus the rollup field carrying the value and a scale onto the unit
 * Fitbit used. `undefined` marks a resource with no equivalent.
 */
const ACTIVITY_RESOURCE_MAP: Record<
  ActivityResourceT,
  { dataType: string; field: string; scale?: number } | undefined
> = {
  steps: { dataType: 'steps', field: 'countSum' },
  // Google reports distance in millimetres; Fitbit's series is kilometres.
  distance: { dataType: 'distance', field: 'millimetersSum', scale: 1 / 1_000_000 },
  calories: { dataType: 'total-calories', field: 'kcalSum' },
  caloriesBMR: { dataType: 'basal-energy-burned', field: 'kcalSum' },
  activityCalories: { dataType: 'active-energy-burned', field: 'kcalSum' },
  floors: { dataType: 'floors', field: 'countSum' },
  elevation: undefined,
  minutesSedentary: { dataType: 'activity-level', field: 'SEDENTARY' },
  minutesLightlyActive: { dataType: 'activity-level', field: 'LIGHTLY_ACTIVE' },
  minutesFairlyActive: { dataType: 'activity-level', field: 'MODERATELY_ACTIVE' },
  minutesVeryActive: { dataType: 'activity-level', field: 'VERY_ACTIVE' },
};

export class GoogleHealthProvider implements HealthProvider {
  private readonly client: GoogleHealthClient;
  /**
   * Resolved once from the environment rather than read from module state, so
   * the provider behaves identically however it is constructed — a silently
   * UTC-defaulted instance is the kind of bug that only shows up as data an
   * hour out of place.
   */
  private readonly timeZone: string;

  constructor(private readonly env: Env) {
    this.client = new GoogleHealthClient(env);
    this.timeZone = env.TIMEZONE?.trim() || 'UTC';
  }

  // ---------------------------------------------------------------- helpers

  private async list(
    dataType: string,
    timeField: TimeField,
    start: string,
    end: string,
    opts: { limit?: number } = {},
  ): Promise<Row[]> {
    const rows = await this.client.listAll(dataType, {
      filter: dayRangeFilter(dataType, timeField, start, end, this.timeZone),
      pageSize: Math.min(maxPageSize(dataType), 1000),
      limit: opts.limit,
    });
    return rows as Row[];
  }

  /**
   * List a data type and unwrap each DataPoint to its payload.
   *
   * A DataPoint nests its values under a camelCase key named for the type, so
   * a `daily-resting-heart-rate` row arrives as
   * `{dailyRestingHeartRate: {date, beatsPerMinute}}` rather than with those
   * fields at the top level. Reading the wrapper directly yields undefined for
   * every field, which is silent rather than loud, so every read goes through
   * here.
   */
  private async listPayloads(
    dataType: string,
    timeField: TimeField,
    start: string,
    end: string,
    opts: { limit?: number } = {},
  ): Promise<Row[]> {
    const rows = await this.list(dataType, timeField, start, end, opts);
    const key = kebabToCamel(dataType);
    return rows.map((r) => GoogleHealthProvider.unwrap(r, key));
  }

  /** Unwrap a DataPoint into its type-specific payload plus resource name. */
  private static unwrap(row: Row, key: string): Row {
    const payload = (row[key] ?? {}) as Row;
    return { ...payload, __name: row.name };
  }

  /**
   * Minutes spent at each activity level, per local day.
   *
   * `activity-level` rejects both rollup verbs ("DailyRollup is not supported
   * for data type activity-level"), so the individual periods are listed and
   * summed here instead.
   */
  private async activityLevelMinutesByDay(
    start: string,
    end: string,
  ): Promise<Map<string, Record<string, number>>> {
    const rows = await this.listPayloads('activity-level', 'interval', start, end);
    const byDay = new Map<string, Record<string, number>>();

    for (const row of rows) {
      const interval = (row.interval ?? {}) as Row;
      const level = String(row.activityLevelType ?? '');
      const day = pointDate(row);
      if (!level || !day) continue;

      const from = Date.parse(interval.startTime as string);
      const to = Date.parse(interval.endTime as string);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

      const bucket = byDay.get(day) ?? {};
      bucket[level] = (bucket[level] ?? 0) + (to - from) / 60000;
      byDay.set(day, bucket);
    }

    for (const bucket of byDay.values()) {
      for (const k of Object.keys(bucket)) bucket[k] = Math.round(bucket[k] as number);
    }
    return byDay;
  }

  private assertRollupRange(dataType: string, start: string, end: string): void {
    const cap = rollupRangeCapDays(dataType);
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    );
    if (days > cap) {
      throw new UnsupportedOperationError(
        `Google Health caps ${dataType} rollups at ${cap} days per request; ${days} were requested.`,
        `Split the range into chunks of ${cap} days or fewer.`,
      );
    }
  }

  /**
   * The user's IANA zone from Google settings, cached for a day. Falls back to
   * the TIMEZONE variable when settings are not readable. A failed request
   * throws inside the fetcher, so the fallback is never cached.
   */
  private async userTimeZone(): Promise<string> {
    try {
      return await getCached(
        this.env,
        'google_settings_timezone',
        async () => {
          const text = await this.client.requestText({ path: '/users/me/settings' });
          const tz = (JSON.parse(text) as Row).timeZone;
          if (typeof tz !== 'string' || tz === '') throw new Error('settings has no timeZone');
          return tz;
        },
        { ttlSec: 86_400 },
      );
    } catch {
      return this.timeZone;
    }
  }

  /** Age from the Google profile, cached for a day. Undefined when not readable. */
  private async profileAge(): Promise<number | undefined> {
    try {
      return await getCached(
        this.env,
        'google_profile_age',
        async () => {
          const text = await this.client.requestText({ path: '/users/me/profile' });
          const age = num((JSON.parse(text) as Row).age);
          // Throwing keeps a missing age out of the cache.
          if (age === undefined) throw new Error('profile has no age');
          return age;
        },
        { ttlSec: 86_400 },
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Minutes with and without heart-rate data per local date. One 1-minute
   * heart-rate rollup per day (about 1 s each), a few days at a time, with a
   * field mask that keeps only the bucket start. Undefined on any error, so
   * a failed day never looks like a day without data.
   */
  private async heartRateCoverageByDay(
    start: string,
    end: string,
  ): Promise<Map<string, { withData: number; withoutData: number }> | undefined> {
    try {
      const tz = await this.userTimeZone();
      const now = Date.now();
      const dates: string[] = [];
      for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
      const days = await mapLimit(dates, HR_CONCURRENCY, async (date) => {
        const from = localDayStartUtc(date, tz).getTime();
        const dayEnd = localDayStartUtc(addDays(date, 1), tz).getTime();
        const to = Math.min(dayEnd, now);
        const buckets =
          to > from
            ? await this.client.rollUp(
                'heart-rate',
                new Date(from).toISOString(),
                new Date(to).toISOString(),
                '60s',
                'rollupDataPoints(startTime),nextPageToken',
              )
            : [];
        const withData = buckets.length;
        const total = Math.max(0, Math.floor((to - from) / 60_000));
        return [date, { withData, withoutData: Math.max(0, total - withData) }] as const;
      });
      return new Map(days);
    } catch {
      return undefined;
    }
  }

  /**
   * Resting heart rate around a date: `onDate` is that date's own value, and
   * `latest` is the newest value in the week up to it (for zone bounds, so a
   * day without a resting value still gets zones).
   */
  private async restingHrNear(date: string): Promise<{ onDate?: number; latest?: number }> {
    const rows = await this.listPayloads(
      'daily-resting-heart-rate',
      'daily',
      addDays(date, -7),
      date,
    ).catch(() => [] as Row[]);
    let best: { date: string; bpm: number } | undefined;
    let onDate: number | undefined;
    for (const r of rows) {
      const d = fromCivilDate(r.date);
      const bpm = num(r.beatsPerMinute);
      if (!d || bpm === undefined) continue;
      if (d === date) onDate = bpm;
      if (!best || d > best.date) best = { date: d, bpm };
    }
    return { onDate, latest: best?.bpm };
  }

  /**
   * Raw heart-rate samples in `[startMs, endMs)`, oldest first.
   *
   * The range is split into 2-hour windows. One window fits in one or two
   * pages (the API caps a page at 5000 points), and the windows are fetched a
   * few at a time. The field mask drops everything except time and value.
   * A single unsplit day listing is newest-first and gets cut by the page
   * limit, which is how the morning used to go missing.
   */
  private async heartRateSamples(
    startMs: number,
    endMs: number,
    fallbackOffsetMs: number,
  ): Promise<HrSample[]> {
    const path = filterPath('heart-rate', 'sample');
    const windows: Array<[number, number]> = [];
    for (let a = startMs; a < endMs; a += HR_CHUNK_MS) {
      windows.push([a, Math.min(a + HR_CHUNK_MS, endMs)]);
    }
    const parts = await mapLimit(windows, HR_CONCURRENCY, async ([a, b]) => {
      const rows = await this.client.listAll('heart-rate', {
        filter: `${path} >= "${isoUtc(a)}" AND ${path} < "${isoUtc(b)}"`,
        pageSize: maxPageSize('heart-rate'),
        fields: HR_FIELDS,
      });
      return parseHrRows(rows, fallbackOffsetMs);
    });
    // Each part is sorted and the windows are in order, so the join is sorted.
    return parts.flat();
  }

  /** A time window as UTC and local ISO strings, local per the given zone. */
  private static window(startMs: number, endMs: number, timeZone: string): TimeWindow {
    return {
      start_utc: isoUtc(startMs),
      end_utc: isoUtc(endMs),
      start_local: isoLocal(startMs, zoneOffsetMs(new Date(startMs), timeZone)),
      end_local: isoLocal(endMs, zoneOffsetMs(new Date(endMs), timeZone)),
    };
  }

  /**
   * Load one exercise data point.
   *
   * A Google id is fetched directly. A numeric logId is a hash of the resource
   * name, so it is found by scanning a window of exercises: three days around
   * `date` when given, else the last 90 days.
   */
  private async findExercise(ref: ExerciseRef): Promise<Row> {
    if (ref.exerciseId) {
      const id = exerciseIdOf(ref.exerciseId);
      const text = await this.client.requestText({
        path: `/users/me/dataTypes/exercise/dataPoints/${id}`,
      });
      return JSON.parse(text) as Row;
    }
    if (ref.logId === undefined) {
      throw new RangeError('Pass exerciseId (preferred) or logId.');
    }
    const end = ref.date ? addDays(ref.date, 1) : today(this.timeZone);
    const start = ref.date ? addDays(ref.date, -1) : addDays(end, -EXERCISE_LOOKBACK_DAYS);
    const rows = await this.list('exercise', 'interval', start, end);
    const match = rows.find((r) => nameToNumericId(r.name) === ref.logId);
    if (!match) {
      throw new UnsupportedOperationError(
        `No exercise with logId ${ref.logId} was found between ${start} and ${end}.`,
        'Call get_exercise_list and pass its exerciseId, or add the workout date.',
      );
    }
    return match;
  }

  // ------------------------------------------------------------------ read

  async getProfile(): Promise<Profile> {
    // Fitbit returned identity, profile and unit settings from one endpoint;
    // Google splits them across three. Settings needs `settings.readonly`,
    // which a token minted before that scope was granted will not carry, so a
    // failure there degrades to a partial profile rather than failing the call.
    const [identity, profile, settings] = await Promise.all([
      this.getJsonOrEmpty('/users/me/identity'),
      this.getJsonOrEmpty('/users/me/profile'),
      this.getJsonOrEmpty('/users/me/settings'),
    ]);

    return {
      user: {
        encodedId: String(identity.legacyUserId ?? identity.healthUserId ?? ''),
        // `name` on these resources is the API resource path
        // ("users/123/settings"), not a human name — there is no display name
        // in the v4 profile, so leave it unset rather than echo a path.
        age: num(profile.age),
        timezone: (settings.timeZone as string) ?? undefined,
        locale: (settings.languageLocale as string) ?? undefined,
        memberSince: fromCivilDate(profile.membershipStartDate),
        offsetFromUTCMillis: durationMs(settings.utcOffset),
        heightUnit: (settings.heightUnit as string) ?? undefined,
        weightUnit: (settings.weightUnit as string) ?? undefined,
      },
    };
  }

  private async getJsonOrEmpty(path: string): Promise<Row> {
    try {
      return JSON.parse(await this.client.requestText({ path })) as Row;
    } catch {
      return {};
    }
  }

  async listDevices(): Promise<Device[]> {
    const text = await this.client.requestText({ path: '/users/me/pairedDevices' });
    const body = JSON.parse(text) as { pairedDevices?: Row[] };
    return (body.pairedDevices ?? []).map((d) => ({
      id: String(d.name ?? ''),
      deviceVersion: (d.deviceVersion as string) ?? undefined,
      type: (d.deviceType as string) ?? undefined,
      battery: (d.batteryStatus as string) ?? undefined,
      batteryLevel: num(d.batteryLevel),
      lastSyncTime: (d.lastSyncTime as string) ?? undefined,
      mac: (d.macAddress as string) ?? undefined,
      features: Array.isArray(d.features) ? (d.features as string[]) : undefined,
    }));
  }

  async getDailySummary(date: string): Promise<DailySummary> {
    // Fitbit served this from one endpoint; Google needs one rollup per
    // metric. They are independent, so fire them together and let a single
    // unavailable metric come back undefined rather than failing the summary.
    const [steps, calories, distance, floors, activity, azm, rhr, age, coverage] =
      await Promise.all([
        this.client.dailyRollUp('steps', date, date).catch(() => []),
        this.client.dailyRollUp('total-calories', date, date).catch(() => []),
        this.client.dailyRollUp('distance', date, date).catch(() => []),
        this.client.dailyRollUp('floors', date, date).catch(() => []),
        this.activityLevelMinutesByDay(date, date).catch(() => new Map()),
        this.client.dailyRollUp('active-zone-minutes', date, date).catch(() => undefined),
        this.restingHrNear(date),
        this.profileAge(),
        this.heartRateCoverageByDay(date, date),
      ]);
    const hr = coverage?.get(date);

    const levels = activity.get(date) ?? {};
    const distanceMm = num(pickRollup(distance[0], 'millimetersSum'));

    return {
      summary: {
        steps: num(pickRollup(steps[0], 'countSum')),
        caloriesOut: num(pickRollup(calories[0], 'kcalSum')),
        floors: num(pickRollup(floors[0], 'countSum')),
        distances:
          distanceMm === undefined
            ? undefined
            : [{ activity: 'total', distance: distanceMm / 1_000_000 }],
        sedentaryMinutes: levels.SEDENTARY,
        lightlyActiveMinutes: levels.LIGHTLY_ACTIVE,
        fairlyActiveMinutes: levels.MODERATELY_ACTIVE,
        veryActiveMinutes: levels.VERY_ACTIVE,
        restingHeartRate: rhr.onDate,
        heartRateZones: heartRateZonesOf(
          azmBucket(azm, date, hr),
          fitbitZones(age, rhr.latest)?.zones,
          hr?.withData,
        ),
        minutesWithoutHeartRate: hr?.withoutData,
      },
    };
  }

  async getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries> {
    const mapping = ACTIVITY_RESOURCE_MAP[resource];
    if (!mapping) {
      throw new UnsupportedOperationError(
        `Google Health has no equivalent for the "${resource}" time series.`,
        'Supported: steps, distance, calories, caloriesBMR, activityCalories, floors, and the four minutes* levels.',
      );
    }
    this.assertRollupRange(mapping.dataType, start, end);

    // activity-level has no rollup verb, so its series is summed from listed
    // periods instead.
    if (mapping.dataType === 'activity-level') {
      const byDay = await this.activityLevelMinutesByDay(start, end);
      const points = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, levels]) => ({ dateTime: day, value: levels[mapping.field] ?? 0 }));
      return { resource, points };
    }

    const buckets = await this.client.dailyRollUp(mapping.dataType, start, end);
    const points = buckets.map((b) => {
      const raw = num(pickRollup(b, mapping.field));
      const scaled = raw === undefined ? 0 : raw * (mapping.scale ?? 1);
      return { dateTime: rollupDate(b) ?? start, value: scaled };
    });
    return { resource, points };
  }

  async getExerciseList(opts: ExerciseListOptions): Promise<ExerciseLog[]> {
    // Google filters a window instead of paging back from a date. Without
    // `from`, a 90-day lookback stands in for "the most recent N".
    const to = opts.to ?? opts.beforeDate ?? today(this.timeZone);
    const from = opts.from ?? addDays(to, -EXERCISE_LOOKBACK_DAYS);
    if (from > to) throw new RangeError(`Range is inverted: from=${from} > to=${to}`);
    if (from < addDays(to, -MAX_EXERCISE_RANGE_DAYS)) {
      throw new RangeError(
        `The range is longer than ${MAX_EXERCISE_RANGE_DAYS} days. Split it into shorter ranges.`,
      );
    }
    const fallbackOff = zoneOffsetMs(new Date(), this.timeZone);
    const rows = await this.list('exercise', 'interval', from, to, { limit: opts.limit });
    const out: ExerciseLog[] = [];
    for (const row of rows) {
      const rec = readExercise(row, fallbackOff);
      if (rec) out.push(rec.log);
    }
    return out;
  }

  async getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]> {
    // Zone minutes cost one rollup call; ranges longer than AZM_RANGE_DAYS get
    // zone bounds without minutes (the tool description says the same).
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
    const withMinutes = days <= AZM_RANGE_DAYS;
    const [rows, age, azm, coverage] = await Promise.all([
      this.listPayloads('daily-resting-heart-rate', 'daily', start, end),
      this.profileAge(),
      withMinutes
        ? this.client.dailyRollUp('active-zone-minutes', start, end).catch(() => undefined)
        : Promise.resolve(undefined),
      withMinutes ? this.heartRateCoverageByDay(start, end) : Promise.resolve(undefined),
    ]);
    return rows.map((r) => {
      const dateTime = fromCivilDate(r.date) ?? start;
      const restingHr = num(r.beatsPerMinute);
      const hr = coverage?.get(dateTime);
      return {
        dateTime,
        value: {
          restingHeartRate: restingHr,
          heartRateZones: heartRateZonesOf(
            azmBucket(azm, dateTime, hr),
            fitbitZones(age, restingHr)?.zones,
            hr?.withData,
          ),
          minutesWithoutHeartRate: hr?.withoutData,
        },
      };
    });
  }

  async getHeartRateIntraday(
    date: string,
    detailLevel: IntradayDetailLevelT,
    window: IntradayWindow = {},
  ): Promise<HeartRateIntraday> {
    // Google stores raw samples only, every 1-5 s during a workout and less
    // often at rest. 1sec returns them as they are; the other levels average
    // them into buckets here.
    const bucketSec = { '1sec': 0, '1min': 60, '5min': 300, '15min': 900 }[detailLevel];
    const tz = await this.userTimeZone();
    const from = window.startTime
      ? localTimeToUtcMs(date, window.startTime, tz, 'start_time')
      : localDayStartUtc(date, tz).getTime();
    const to = window.endTime
      ? localTimeToUtcMs(date, window.endTime, tz, 'end_time')
      : localDayStartUtc(addDays(date, 1), tz).getTime();
    if (to <= from) throw new RangeError('end_time must be later than start_time.');
    // No point asking for the future part of today.
    const fetchEnd = Math.min(to, Date.now());
    const offset = zoneOffsetMs(new Date(from), tz);

    const [samples, rhr, azm, age, coverage] = await Promise.all([
      fetchEnd > from
        ? this.heartRateSamples(from, fetchEnd, offset)
        : Promise.resolve([] as HrSample[]),
      this.restingHrNear(date),
      this.client.dailyRollUp('active-zone-minutes', date, date).catch(() => undefined),
      this.profileAge(),
      this.heartRateCoverageByDay(date, date),
    ]);
    const hr = coverage?.get(date);
    const restingHr = rhr.onDate;
    const fz = fitbitZones(age, rhr.latest);

    return {
      date,
      timeZone: tz,
      detailLevel,
      window: GoogleHealthProvider.window(from, to, tz),
      restingHeartRate: restingHr,
      heartRateZones: heartRateZonesOf(azmBucket(azm, date, hr), fz?.zones, hr?.withData),
      minutesWithoutHeartRate: hr?.withoutData,
      zoneBasis: fz?.basis,
      summary: summarize(samples),
      points: bucketize(samples, bucketSec),
    };
  }

  async getHeartRateSeries(
    start: string,
    end: string,
    resolution: HrResolutionT,
  ): Promise<HeartRateSeries> {
    const startMs = parseZonedIso(start, 'start');
    const endMs = parseZonedIso(end, 'end');
    assertSeriesWindow(startMs, endMs);
    const tz = await this.userTimeZone();
    // The whole `end` second is included, the same way a workout keeps its
    // stop second. So a window copied from a workout gives the same series.
    const samples = await this.heartRateSamples(
      startMs,
      Math.floor(endMs / 1000) * 1000 + 1000,
      zoneOffsetMs(new Date(startMs), tz),
    );
    return {
      timeZone: tz,
      resolution,
      window: GoogleHealthProvider.window(startMs, endMs, tz),
      summary: summarize(samples),
      points: bucketize(samples, RESOLUTION_SEC[resolution]),
    };
  }

  async getExerciseHeartRate(
    ref: ExerciseRef,
    opts: ExerciseHrOptions,
  ): Promise<ExerciseHeartRate> {
    // Parse first, so a bad plan fails before any API call.
    const steps = opts.plan === undefined ? undefined : parsePlan(opts.plan);
    const tz = await this.userTimeZone();
    const rec = readExercise(await this.findExercise(ref), zoneOffsetMs(new Date(), tz));
    if (!rec) throw new UnsupportedOperationError('This exercise has no valid start and end time.');

    // `+ 1000` keeps a sample stamped at the exact stop second.
    const pad = opts.paddingMinutes * 60_000;
    const from = rec.startMs - pad;
    const to = rec.endMs + pad + 1000;
    assertSeriesWindow(from, to);
    // HRR60 can need samples up to 70 s after the workout ends.
    const fetchTo = steps ? Math.max(to, rec.endMs + 75_000) : to;

    const workoutDate = isoLocal(rec.startMs, rec.offMs).slice(0, 10);
    const [samples, age, rhr] = await Promise.all([
      this.heartRateSamples(from, fetchTo, rec.offMs),
      this.profileAge(),
      this.restingHrNear(workoutDate),
    ]);

    // Statistics cover the session only; padding is for context in `points`.
    const session = sliceByTime(samples, rec.startMs, rec.endMs + 1000);
    const e = rec.raw;
    const metrics = (e.metricsSummary ?? {}) as Row;

    const fz = fitbitZones(age, rhr.latest, opts.maxHr);
    const maxHr = opts.maxHr ?? (age ? 220 - age : undefined);

    const rawEvents = ((e.exerciseEvents as Row[] | undefined) ?? []).flatMap((ev) => {
      const t = Date.parse(ev.eventTime as string);
      if (!Number.isFinite(t)) return [];
      const off = durationMs(ev.eventUtcOffset) ?? rec.offMs;
      return [{ type: String(ev.exerciseEventType ?? ''), t, off }];
    });
    const events = rawEvents.map((ev) => ({
      type: ev.type,
      time_utc: isoUtc(ev.t),
      time_local: isoLocal(ev.t, ev.off),
    }));

    const workLabel = opts.workLabel ?? 'r';
    const plan =
      steps && opts.plan !== undefined
        ? {
            text: opts.plan,
            workLabel,
            ...analyzeSegments(samples, steps, {
              startMs: rec.startMs,
              endMs: rec.endMs,
              offMs: rec.offMs,
              pauses: pausesFromEvents(rawEvents),
              workLabel,
            }),
          }
        : undefined;

    const laps = ((e.splitSummaries as Row[] | undefined) ?? []).flatMap((sp, index) => {
      const a = Date.parse(sp.startTime as string);
      const b = Date.parse(sp.endTime as string);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
      const off = durationMs(sp.startUtcOffset) ?? rec.offMs;
      const m = (sp.metricsSummary ?? {}) as Row;
      const mm = num(m.distanceMillimeters);
      const active = durationMs(sp.activeDuration);
      return [
        {
          index: index + 1,
          splitType: (sp.splitType as string) ?? undefined,
          window: {
            start_utc: isoUtc(a),
            end_utc: isoUtc(b),
            start_local: isoLocal(a, off),
            end_local: isoLocal(b, durationMs(sp.endUtcOffset) ?? off),
          },
          activeDurationSec: active === undefined ? undefined : Math.round(active / 1000),
          distanceKm: mm === undefined ? undefined : mm / 1_000_000,
          googleAverageHeartRate: num(m.averageHeartRateBeatsPerMinute),
          heartRate: summarize(sliceByTime(session, a, b)),
        },
      ];
    });

    return {
      exercise: { ...rec.log, window: rec.window },
      timeZone: tz,
      resolution: opts.resolution,
      paddingMinutes: opts.paddingMinutes,
      summary: summarize(session),
      timeInZones: fz && { ...fz.basis, zones: timeInZones(session, fz.zones, rec.endMs) },
      zones: {
        google: readGoogleZones(metrics.heartRateZoneDurations),
        bevel:
          maxHr === undefined ? undefined : timeInZones(session, percentMaxZones(maxHr), rec.endMs),
        custom: opts.customZones
          ? timeInZones(
              session,
              customZones(
                opts.customZones,
                maxHr ?? session.reduce((m, x) => Math.max(m, x.bpm), 0),
              ),
              rec.endMs,
            )
          : undefined,
      },
      plan,
      events,
      laps,
      points:
        opts.includePoints === false
          ? []
          : bucketize(sliceByTime(samples, from, to), RESOLUTION_SEC[opts.resolution]),
    };
  }

  async exportExerciseTcx(
    ref: ExerciseRef,
    opts: { partialData: boolean },
  ): Promise<{ exerciseId: string; logId: number; tcx: string }> {
    // Load the record even for an exerciseId: its resource name gives both ids.
    const name = String((await this.findExercise(ref)).name ?? '');
    const id = exerciseIdOf(name);
    const ids = { exerciseId: id, logId: nameToNumericId(name) };
    const text = await this.client.requestText({
      path: `/users/me/dataTypes/exercise/dataPoints/${id}:exportExerciseTcx`,
      query: { alt: 'media', partialData: String(opts.partialData) },
      accept: 'application/vnd.garmin.tcx+xml, application/xml, application/json',
    });
    // Without alt=media the API wraps the file as {"tcxData": "..."}.
    const tcx = text.trimStart().startsWith('{')
      ? String((JSON.parse(text) as Row).tcxData ?? '')
      : text;
    return { ...ids, tcx };
  }

  async getSleep(date: string): Promise<SleepLog[]> {
    return this.getSleepRange(date, date);
  }

  async getSleepRange(start: string, end: string): Promise<SleepLog[]> {
    const rows = await this.list('sleep', 'interval', start, end);
    return rows.map((row) => {
      const s = GoogleHealthProvider.unwrap(row, 'sleep');
      const interval = (s.interval ?? {}) as Row;
      const summary = (s.summary ?? {}) as Row;

      const startTime = (interval.startTime as string) ?? '';
      const endTime = (interval.endTime as string) ?? '';
      const spanMs =
        Date.parse(endTime) && Date.parse(startTime)
          ? Date.parse(endTime) - Date.parse(startTime)
          : 0;

      const minutesAsleep = num(summary.minutesAsleep) ?? 0;
      const inPeriod = num(summary.minutesInSleepPeriod);

      const stageSummary: Record<string, Record<string, number>> = {};
      for (const st of (summary.stagesSummary as Row[] | undefined) ?? []) {
        const level = SLEEP_STAGE_TO_LEVEL[String(st.type)] ?? String(st.type).toLowerCase();
        stageSummary[level] = { count: num(st.count) ?? 0, minutes: num(st.minutes) ?? 0 };
      }

      return {
        logId: nameToNumericId(s.__name),
        // A night belongs to the local day it ends on. The API sends no
        // civil end time for sleep, so derive it from the end instant.
        dateOfSleep:
          fromCivilDate((interval.civilEndTime as Row | undefined)?.date) ??
          localDateOf(endTime, interval.endUtcOffset, this.timeZone) ??
          end,
        startTime,
        endTime,
        duration: spanMs,
        minutesAsleep,
        minutesAwake: num(summary.minutesAwake),
        minutesToFallAsleep: num(summary.minutesToFallAsleep),
        timeInBed: inPeriod,
        efficiency:
          inPeriod && inPeriod > 0 ? Math.round((minutesAsleep / inPeriod) * 100) : undefined,
        type: (s.type as string) ?? undefined,
        levels: {
          summary: stageSummary,
          data: ((s.stages as Row[] | undefined) ?? []).map((st) => ({
            dateTime: (st.startTime as string) ?? '',
            level: SLEEP_STAGE_TO_LEVEL[String(st.type)] ?? String(st.type).toLowerCase(),
            seconds: stageSeconds(st),
          })),
        },
      };
    });
  }

  async getBodyLog(start: string, end: string): Promise<BodyLog> {
    const [weightRows, fatRows] = await Promise.all([
      this.list('weight', 'sample', start, end),
      this.list('body-fat', 'sample', start, end),
    ]);

    const weight: WeightLog[] = weightRows.map((row) => {
      const w = GoogleHealthProvider.unwrap(row, 'weight');
      return {
        logId: nameToNumericId(w.__name),
        date: pointDate(w) ?? start,
        time: pointTimestamp(w)?.slice(11, 19),
        weight: (num(w.weightGrams) ?? 0) / 1000,
      };
    });

    const fat: BodyFatLog[] = fatRows.map((row) => {
      const f = GoogleHealthProvider.unwrap(row, 'bodyFat');
      return {
        logId: nameToNumericId(f.__name),
        date: pointDate(f) ?? start,
        time: pointTimestamp(f)?.slice(11, 19),
        fat: num(f.percentage) ?? 0,
      };
    });

    return { weight, fat };
  }

  async getFoodLog(date: string): Promise<FoodLog> {
    const [foodRows, waterRows] = await Promise.all([
      this.list('nutrition-log', 'interval', date, date),
      this.list('hydration-log', 'interval', date, date).catch(() => []),
    ]);

    const foods: FoodLogEntry[] = foodRows.map((row) => {
      const n = GoogleHealthProvider.unwrap(row, 'nutritionLog');
      return {
        logId: nameToNumericId(n.__name),
        loggedFood: {
          name: (n.foodDisplayName as string) ?? undefined,
          mealTypeId: GOOGLE_TO_MEAL_TYPE_ID[String(n.mealType)] ?? 7,
          amount: num((n.serving as Row | undefined)?.amount),
          calories: num((n.energy as Row | undefined)?.kcal),
        },
        nutritionalValues: readNutrients(n),
        logDate: pointDate(n) ?? date,
      };
    });

    const water: WaterLogEntry[] = waterRows.map((row) => {
      const h = GoogleHealthProvider.unwrap(row, 'hydrationLog');
      return {
        logId: nameToNumericId(h.__name),
        amount: num((h.amountConsumed as Row | undefined)?.milliliters) ?? 0,
      };
    });

    const summary: Record<string, number> = {};
    for (const f of foods) {
      const v = f.nutritionalValues ?? {};
      summary.calories = (summary.calories ?? 0) + (f.loggedFood?.calories ?? 0);
      summary.protein = (summary.protein ?? 0) + (v.protein ?? 0);
      summary.carbs = (summary.carbs ?? 0) + (v.carbs ?? 0);
      summary.fat = (summary.fat ?? 0) + (v.fat ?? 0);
      summary.fiber = (summary.fiber ?? 0) + (v.fiber ?? 0);
      summary.sodium = (summary.sodium ?? 0) + (v.sodium ?? 0);
    }

    const totalWater = water.reduce((a, w) => a + w.amount, 0);
    return {
      foods,
      summary: { ...summary, water: totalWater },
      water: { summary: { water: totalWater }, water },
    };
  }

  async getSpO2(start: string, end: string): Promise<SpO2Day[]> {
    const rows = await this.listPayloads('daily-oxygen-saturation', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: {
        avg: num(r.averagePercentage),
        min: num(r.lowerBoundPercentage),
        max: num(r.upperBoundPercentage),
      },
    }));
  }

  async getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]> {
    const rows = await this.listPayloads('daily-respiratory-rate', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: { breathingRate: num(r.breathsPerMinute) },
    }));
  }

  async getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]> {
    const rows = await this.listPayloads(
      'daily-sleep-temperature-derivations',
      'daily',
      start,
      end,
    );
    return rows.map((r) => {
      const nightly = num(r.nightlyTemperatureCelsius);
      const baseline = num(r.baselineTemperatureCelsius);
      return {
        dateTime: fromCivilDate(r.date) ?? start,
        // Google reports an absolute nightly temperature plus a baseline;
        // Fitbit reported only the deviation, so derive it to keep the field
        // comparable with historical data.
        value: {
          nightlyRelative:
            nightly !== undefined && baseline !== undefined
              ? Number((nightly - baseline).toFixed(2))
              : undefined,
          nightlyCelsius: nightly === undefined ? undefined : Number(nightly.toFixed(2)),
        },
        logType: 'nightly',
      };
    });
  }

  async getHRV(start: string, end: string): Promise<HrvDay[]> {
    const rows = await this.listPayloads('daily-heart-rate-variability', 'daily', start, end);
    return rows.map((r) => ({
      dateTime: fromCivilDate(r.date) ?? start,
      value: {
        dailyRmssd: num(r.averageHeartRateVariabilityMilliseconds),
        deepRmssd: num(r.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
      },
    }));
  }

  async getCardioFitness(date: string): Promise<CardioFitness> {
    // VO2 max is not recomputed daily, so look back a month and take the most
    // recent reading rather than returning nothing for a quiet day.
    const rows = await this.listPayloads('daily-vo2-max', 'daily', addDays(date, -30), date);
    const latest = rows[rows.length - 1] as Row | undefined;
    return {
      dateTime: latest ? (fromCivilDate(latest.date) ?? date) : date,
      value: { vo2Max: num(latest?.vo2Max) },
    };
  }

  // ----------------------------------------------------------------- write

  async logFood(input: LogFoodInput): Promise<FoodLogEntry> {
    const v = input.nutritionalValues ?? {};
    const nutrients: Array<Record<string, unknown>> = [];
    for (const [key, enumName] of Object.entries(NUTRIENT)) {
      const grams = v[key as keyof typeof v];
      if (grams !== undefined) nutrients.push({ nutrient: enumName, quantity: { grams } });
    }

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/nutrition-log/dataPoints',
      method: 'POST',
      json: {
        nutritionLog: {
          foodDisplayName: input.foodName,
          mealType: googleMealType(input.mealType),
          energy: { kcal: input.calories },
          interval: mealInterval(input.date, input.mealType),
          ...(v.fat !== undefined ? { totalFat: { grams: v.fat } } : {}),
          ...(v.carbs !== undefined ? { totalCarbohydrate: { grams: v.carbs } } : {}),
          ...(nutrients.length ? { nutrients } : {}),
        },
      },
    });

    const created = JSON.parse(text) as Row;
    return {
      logId: nameToNumericId(created.name),
      loggedFood: {
        name: input.foodName,
        mealTypeId: GOOGLE_TO_MEAL_TYPE_ID[googleMealType(input.mealType)] ?? 7,
        calories: input.calories,
        amount: input.amount ?? 1,
      },
      nutritionalValues: readNutrients(GoogleHealthProvider.unwrap(created, 'nutritionLog')),
      logDate: input.date,
    };
  }

  async logMeal(input: LogMealInput): Promise<FoodLogEntry[]> {
    const out: FoodLogEntry[] = [];
    // Sequential on purpose: a partial failure stays attributable to one item
    // rather than collapsing the whole meal into a single opaque error.
    for (const item of input.items) {
      out.push(
        await this.logFood({
          date: input.date,
          mealType: input.mealType,
          foodName: item.name,
          calories: item.calories,
          nutritionalValues: { protein: item.protein, carbs: item.carbs, fat: item.fat },
        }),
      );
    }
    return out;
  }

  async logWater(input: LogWaterInput): Promise<WaterLogEntry> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/hydration-log/dataPoints',
      method: 'POST',
      json: {
        hydrationLog: {
          amountConsumed: { milliliters: input.amountMl },
          interval: instantInterval(input.date),
        },
      },
    });
    return { logId: nameToNumericId((JSON.parse(text) as Row).name), amount: input.amountMl };
  }

  async logWeight(input: LogWeightInput): Promise<WeightLog> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/weight/dataPoints',
      method: 'POST',
      json: {
        weight: {
          weightGrams: Math.round(input.weightKg * 1000),
          sampleTime: sampleTime(input.date, input.time),
        },
      },
    });
    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      date: input.date,
      time: input.time,
      weight: input.weightKg,
    };
  }

  async logBodyFat(input: LogBodyFatInput): Promise<BodyFatLog> {
    const text = await this.client.requestText({
      path: '/users/me/dataTypes/body-fat/dataPoints',
      method: 'POST',
      json: {
        bodyFat: {
          percentage: input.fatPercent,
          sampleTime: sampleTime(input.date, input.time),
        },
      },
    });
    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      date: input.date,
      time: input.time,
      fat: input.fatPercent,
    };
  }

  async logActivity(input: LogActivityInput): Promise<ExerciseLog> {
    const startIso = `${input.date}T${input.startTime}Z`;
    const endIso = isoSecond(Date.parse(startIso) + input.durationMs);

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/exercise/dataPoints',
      method: 'POST',
      json: {
        exercise: {
          displayName: input.activityName ?? 'Workout',
          exerciseType: 'EXERCISE_TYPE_UNSPECIFIED',
          activeDuration: `${Math.round(input.durationMs / 1000)}s`,
          interval: { startTime: startIso, endTime: endIso },
          ...(input.manualCalories !== undefined || input.distanceKm !== undefined
            ? {
                metricsSummary: {
                  ...(input.manualCalories !== undefined
                    ? { caloriesKcal: input.manualCalories }
                    : {}),
                  ...(input.distanceKm !== undefined
                    ? { distanceMillimeters: Math.round(input.distanceKm * 1_000_000) }
                    : {}),
                },
              }
            : {}),
        },
      },
    });

    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      activityName: input.activityName,
      startTime: startIso,
      duration: input.durationMs,
      calories: input.manualCalories,
      distance: input.distanceKm,
      distanceUnit: 'km',
    };
  }

  /** A workout the band missed, at local times, with the band's average heart rate for it. */
  async logWorkout(input: LogWorkoutInput): Promise<ExerciseLog> {
    const tz = await this.userTimeZone();
    const startMs = localTimeToUtcMs(input.date, input.start, tz, 'start');
    let endMs = localTimeToUtcMs(input.date, input.end, tz, 'end');
    if (endMs <= startMs) endMs = localTimeToUtcMs(addDays(input.date, 1), input.end, tz, 'end');
    if (endMs - startMs < MIN_WORKOUT_MS || endMs - startMs > MAX_WORKOUT_MS) {
      throw new RangeError('A workout must last between 5 minutes and 4 hours.');
    }

    const clash = (await this.exercisesNear(input.date, endMs, tz)).find(
      (r) => r.startMs < endMs && r.endMs > startMs,
    );
    if (clash) {
      throw new UnsupportedOperationError(
        `Fitbit already has "${clash.log.activityName}" from ${clash.window.start_local} to ${clash.window.end_local}.`,
        'Use times that do not overlap it. If it is a duplicate, delete it first.',
      );
    }

    const offMs = zoneOffsetMs(new Date(startMs), tz);
    const avgHr = summarize(await this.heartRateSamples(startMs, endMs, offMs)).avg;
    const offset = (ms: number) => `${zoneOffsetMs(new Date(ms), tz) / 1000}s`;
    const body = await this.client.requestText({
      path: '/users/me/dataTypes/exercise/dataPoints',
      method: 'POST',
      json: {
        exercise: {
          displayName: input.name,
          exerciseType: input.exerciseType,
          interval: {
            startTime: isoSecond(startMs),
            startUtcOffset: offset(startMs),
            endTime: isoSecond(endMs),
            endUtcOffset: offset(endMs),
          },
          activeDuration: `${Math.round((endMs - startMs) / 1000)}s`,
          metricsSummary:
            avgHr === undefined ? {} : { averageHeartRateBeatsPerMinute: Math.round(avgHr) },
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
    });

    // Create answers with a long-running operation, so the new point may only show up on a re-list.
    const op = JSON.parse(body || '{}') as Row;
    const done = readExercise((op.response ?? {}) as Row, offMs);
    if (done) return done.log;
    for (let i = 0; i < CREATE_POLLS; i++) {
      await new Promise((r) => setTimeout(r, CREATE_POLL_MS));
      const found = (await this.exercisesNear(input.date, endMs, tz)).find(
        (r) => Math.abs(r.startMs - startMs) < 1000 && r.log.exerciseType === input.exerciseType,
      );
      if (found) return found.log;
    }
    return {
      activityName: input.name,
      exerciseType: input.exerciseType,
      startTime: isoUtc(startMs),
      endTime: isoUtc(endMs),
      startTime_local: isoLocal(startMs, offMs),
      endTime_local: isoLocal(endMs, zoneOffsetMs(new Date(endMs), tz)),
      activeDurationSec: Math.round((endMs - startMs) / 1000),
      averageHeartRate: avgHr === undefined ? undefined : Math.round(avgHr),
    };
  }

  /** Delete one workout by its Google id. The tool layer limits this to workouts it wrote. */
  async deleteWorkout(exerciseId: string): Promise<void> {
    const row = await this.findExercise({ exerciseId });
    if (typeof row.name !== 'string') throw new RangeError(`No workout ${exerciseId} was found.`);
    await this.client.requestText({
      path: '/users/me/dataTypes/exercise/dataPoints:batchDelete',
      method: 'POST',
      json: { names: [row.name] },
    });
  }

  /** Workouts from every source, from the day before `date` to the local day of `endMs`. */
  private async exercisesNear(date: string, endMs: number, tz: string): Promise<ExerciseRecord[]> {
    const rows = await this.client.listAll('exercise', {
      filter: dayRangeFilter(
        'exercise',
        'interval',
        addDays(date, -1),
        toLocalDateString(endMs, tz),
      ),
      pageSize: maxPageSize('exercise'),
      allSources: true,
    });
    const fallback = zoneOffsetMs(new Date(endMs), tz);
    return (rows as Row[]).map((r) => readExercise(r, fallback)).filter((r) => r !== undefined);
  }

  async logSleep(input: LogSleepInput): Promise<SleepLog> {
    const startIso = `${input.date}T${input.startTime}:00Z`;
    const endIso = isoSecond(Date.parse(startIso) + input.durationMs);
    const minutes = Math.round(input.durationMs / 60000);

    const text = await this.client.requestText({
      path: '/users/me/dataTypes/sleep/dataPoints',
      method: 'POST',
      json: {
        sleep: {
          type: 'CLASSIC',
          interval: { startTime: startIso, endTime: endIso },
          // int64 fields go over the wire as strings.
          summary: { minutesAsleep: String(minutes), minutesInSleepPeriod: String(minutes) },
        },
      },
    });

    return {
      logId: nameToNumericId((JSON.parse(text) as Row).name),
      dateOfSleep: input.date,
      startTime: startIso,
      endTime: endIso,
      duration: input.durationMs,
      minutesAsleep: minutes,
    };
  }

  // ---------------------------------------------------------------- delete

  async deleteFoodLog(logId: number): Promise<void> {
    await this.deleteByNumericId('nutrition-log', 'interval', logId);
  }

  async deleteWaterLog(logId: number): Promise<void> {
    await this.deleteByNumericId('hydration-log', 'interval', logId);
  }

  async deleteWeightLog(logId: number): Promise<void> {
    await this.deleteByNumericId('weight', 'sample', logId);
  }

  async deleteBodyFatLog(logId: number): Promise<void> {
    await this.deleteByNumericId('body-fat', 'sample', logId);
  }

  async deleteActivityLog(logId: number): Promise<void> {
    await this.deleteByNumericId('exercise', 'interval', logId);
  }

  async deleteSleepLog(logId: number): Promise<void> {
    await this.deleteByNumericId('sleep', 'interval', logId);
  }

  /**
   * Resolve one of this server's synthetic numeric ids back to a Google
   * resource name, then delete it.
   *
   * Google identifies a data point by an opaque resource path, but the tool
   * schemas inherited from the Fitbit era hand the model a number. That number
   * is a stable hash of the resource name, so the owning point is found by
   * scanning a recent window and re-hashing. 35 days covers anything this
   * server wrote; older entries have to be removed in the Google Health app.
   */
  private async deleteByNumericId(
    dataType: string,
    timeField: TimeField,
    logId: number,
  ): Promise<void> {
    const end = new Date().toISOString().slice(0, 10);
    const rows = await this.list(dataType, timeField, addDays(end, -35), end);

    const match = rows.find((r) => nameToNumericId(r.name) === logId);
    if (!match?.name) {
      throw new UnsupportedOperationError(
        `No ${dataType} entry with id ${logId} was found in the last 35 days.`,
        'Re-read the log to get a current id, or delete the entry in the Google Health app.',
      );
    }

    await this.client.requestText({
      path: `/users/me/dataTypes/${dataType}/dataPoints:batchDelete`,
      method: 'POST',
      json: { names: [match.name] },
    });
  }
}

// -------------------------------------------------------------- local utils

/** Run `fn` over `items` with at most `limit` calls in flight. Keeps order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function assertSeriesWindow(startMs: number, endMs: number): void {
  if (endMs <= startMs) throw new RangeError('end must be later than start.');
  const hours = (endMs - startMs) / 3_600_000;
  if (endMs - startMs > MAX_SERIES_MS) {
    throw new RangeError(
      `The window is ${hours.toFixed(1)} hours long. The maximum is 24 hours per request; split it into shorter windows.`,
    );
  }
}

/** Last segment of a resource name or a bare id, validated. */
function exerciseIdOf(value: string): string {
  const id = value.split('/').pop() ?? '';
  if (!EXERCISE_ID_RE.test(id)) {
    throw new RangeError(`exerciseId must be the id from get_exercise_list (got: ${value}).`);
  }
  return id;
}

/** Local `YYYY-MM-DD` of an instant, from its own offset when known. */
function localDateOf(iso: string, offset: unknown, timeZone: string): string | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const off = durationMs(offset);
  return off === undefined ? toLocalDateString(t, timeZone) : isoUtc(t + off).slice(0, 10);
}

type ExerciseRecord = {
  log: ExerciseLog;
  window: TimeWindow;
  startMs: number;
  endMs: number;
  /** UTC offset at the start, in milliseconds. */
  offMs: number;
  /** The unwrapped `exercise` payload. */
  raw: Row;
};

/** Map one exercise data point. Times come as UTC plus local with offset. */
function readExercise(row: Row, fallbackOffsetMs: number): ExerciseRecord | undefined {
  const e = (row.exercise ?? {}) as Row;
  const interval = (e.interval ?? {}) as Row;
  const startMs = Date.parse(interval.startTime as string);
  const endMs = Date.parse(interval.endTime as string);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;

  const offMs = durationMs(interval.startUtcOffset) ?? fallbackOffsetMs;
  const endOffMs = durationMs(interval.endUtcOffset) ?? offMs;
  const window: TimeWindow = {
    start_utc: isoUtc(startMs),
    end_utc: isoUtc(endMs),
    start_local: isoLocal(startMs, offMs),
    end_local: isoLocal(endMs, endOffMs),
  };

  const metrics = (e.metricsSummary ?? {}) as Row;
  const distanceMm = num(metrics.distanceMillimeters);
  const activeMs = durationMs(e.activeDuration);
  const name = typeof row.name === 'string' ? row.name : '';
  const splits = e.splitSummaries;

  const log: ExerciseLog = {
    logId: nameToNumericId(name),
    exerciseId: name.split('/').pop() || undefined,
    activityName: (e.displayName as string) ?? (e.exerciseType as string) ?? undefined,
    exerciseType: (e.exerciseType as string) ?? undefined,
    startTime: window.start_utc,
    endTime: window.end_utc,
    startTime_local: window.start_local,
    endTime_local: window.end_local,
    duration: activeMs,
    activeDurationSec: activeMs === undefined ? undefined : Math.round(activeMs / 1000),
    calories: num(metrics.caloriesKcal),
    steps: num(metrics.steps),
    distance: distanceMm === undefined ? undefined : distanceMm / 1_000_000,
    distanceUnit: 'km',
    averageHeartRate: num(metrics.averageHeartRateBeatsPerMinute),
    hasGps: (e.exerciseMetadata as Row | undefined)?.hasGps === true,
    hasLaps: Array.isArray(splits) && splits.length > 0,
  };
  return { log, window, startMs, endMs, offMs, raw: e };
}

/** Google's own zone durations for one workout (`heartRateZoneDurations`). */
const GOOGLE_ZONE_FIELDS: Array<[field: string, name: string]> = [
  ['lightTime', 'Light'],
  ['moderateTime', 'Moderate'],
  ['vigorousTime', 'Vigorous'],
  ['peakTime', 'Peak'],
];

function readGoogleZones(
  durations: unknown,
): Array<{ name: string; seconds: number; minutes: number; percent: number }> | undefined {
  if (!durations || typeof durations !== 'object') return undefined;
  const d = durations as Row;
  const zones = GOOGLE_ZONE_FIELDS.map(([field, name]) => ({
    name,
    seconds: Math.round((durationMs(d[field]) ?? 0) / 1000),
  }));
  const total = zones.reduce((a, z) => a + z.seconds, 0);
  if (total === 0) return undefined;
  return zones.map((z) => ({
    ...z,
    minutes: Math.round(z.seconds / 6) / 10,
    percent: Math.round((z.seconds / total) * 1000) / 10,
  }));
}

/** Pull a named field out of a rollup bucket, whatever nesting it arrives in. */
function pickRollup(bucket: Row | undefined, field: string): unknown {
  if (!bucket) return undefined;
  if (bucket[field] !== undefined) return bucket[field];
  for (const v of Object.values(bucket)) {
    if (v && typeof v === 'object' && field in (v as Row)) return (v as Row)[field];
  }
  return undefined;
}

/**
 * The local date a rollup bucket covers.
 *
 * Buckets label themselves with `civilStartTime`, not `date` — getting this
 * wrong collapses an entire time series onto a single day.
 */
function rollupDate(bucket: Row | undefined): string | undefined {
  if (!bucket) return undefined;
  return (
    fromCivilDate((bucket.civilStartTime as Row | undefined)?.date) ??
    fromCivilDate(bucket.date) ??
    fromCivilDate((bucket.startDate as Row | undefined)?.date) ??
    fromCivilDate((bucket.start as Row | undefined)?.date)
  );
}

/**
 * Heart-rate zones from an `active-zone-minutes` rollup bucket.
 *
 * The bucket carries one flat key per zone — `sumInFatBurnHeartZone`,
 * `sumInCardioHeartZone`, `sumInPeakHeartZone` — rather than an array of zone
 * objects, and no zone bounds at all.
 */
const AZM_ZONE_FIELDS: Array<[field: string, name: string]> = [
  ['sumInFatBurnHeartZone', 'Fat Burn'],
  ['sumInCardioHeartZone', 'Cardio'],
  ['sumInPeakHeartZone', 'Peak'],
];

/**
 * Zones for the `heartRateZones` field.
 *
 * Minutes for Fat Burn, Cardio and Peak come from the zone-minutes rollup
 * (`azm`; a field that is absent there means 0). Google gives no minutes for
 * Out of Range, so they are worked out as minutes with heart-rate data minus
 * the other three zones. The API has no zone bounds, so they come from
 * `bounds` (computed). `azm` undefined means the minutes are unknown.
 */
function heartRateZonesOf(
  azm: Row | undefined,
  bounds: HrZone[] | undefined,
  minutesWithData: number | undefined,
): HeartRateZone[] | undefined {
  const google = new Map(
    AZM_ZONE_FIELDS.map(([field, name]) => [
      name,
      azm ? (num(pickRollup(azm, field)) ?? 0) : undefined,
    ]),
  );
  const googleSum = azm
    ? [...google.values()].reduce<number>((a, b) => a + (b ?? 0), 0)
    : undefined;
  const outOfRange =
    googleSum === undefined || minutesWithData === undefined
      ? undefined
      : Math.max(0, minutesWithData - googleSum);
  const minutesOf = (name: string) => {
    if (name === OUT_OF_RANGE) {
      return outOfRange === undefined ? {} : { minutes: outOfRange, minutesSource: 'computed' };
    }
    const minutes = google.get(name);
    return minutes === undefined ? {} : { minutes, minutesSource: 'google' };
  };
  if (bounds) {
    return bounds.map((z) => ({
      name: z.name,
      min: z.min,
      max: z.max,
      ...minutesOf(z.name),
      source: 'computed',
    }));
  }
  const zones = [OUT_OF_RANGE, ...AZM_ZONE_FIELDS.map(([, name]) => name)]
    .map((name) => ({ name, ...minutesOf(name) }))
    .filter((z) => z.minutes !== undefined);
  return zones.length ? zones : undefined;
}

const OUT_OF_RANGE = 'Out of Range';

/**
 * The zone-minutes bucket of one date. Google skips a day with no zone
 * minutes, so a missing bucket on a day with heart-rate data means 0 minutes.
 * Undefined when the rollup failed or the day has no heart-rate data.
 */
function azmBucket(
  azm: Row[] | undefined,
  date: string,
  hr: { withData: number } | undefined,
): Row | undefined {
  if (!azm) return undefined;
  return azm.find((b) => rollupDate(b) === date) ?? (hr && hr.withData > 0 ? {} : undefined);
}

/** Zone minutes are fetched only for heart-rate ranges up to this many days. */
const AZM_RANGE_DAYS = 14;

/** Smallest heart-rate reserve (max - resting) that gives usable zones. */
const MIN_HR_RESERVE = 20;

/**
 * Fitbit zones for a user. Max heart rate is `maxHrInput` or 220 - age.
 * Undefined when max or resting heart rate is unknown or too close.
 */
function fitbitZones(
  age: number | undefined,
  restingHr: number | undefined,
  maxHrInput?: number,
): { basis: ZoneBasis; zones: HrZone[] } | undefined {
  const maxHr = maxHrInput ?? (age ? 220 - age : undefined);
  // A reserve below MIN_HR_RESERVE gives zones only a few bpm wide; that means bad input.
  if (maxHr === undefined || restingHr === undefined || maxHr - restingHr < MIN_HR_RESERVE) {
    return undefined;
  }
  return {
    basis: {
      source: 'computed',
      method:
        'Fitbit, Karvonen: Fat Burn from 40 %, Cardio from 60 %, Peak from 85 % of heart-rate reserve (max - resting)',
      maxHr,
      maxHrSource: maxHrInput ? 'max_hr input' : `220 - age (${age})`,
      restingHr,
    },
    zones: karvonenZones(maxHr, restingHr),
  };
}

/** Seconds covered by one sleep stage segment. */
function stageSeconds(st: Row): number {
  const a = Date.parse(st.startTime as string);
  const b = Date.parse(st.endTime as string);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : 0;
}

/** Macro values off a NutritionLog payload, under the legacy field names. */
function readNutrients(n: Row): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {
    calories: num((n.energy as Row | undefined)?.kcal),
    fat: num((n.totalFat as Row | undefined)?.grams),
    carbs: num((n.totalCarbohydrate as Row | undefined)?.grams),
  };
  for (const entry of (n.nutrients as Row[] | undefined) ?? []) {
    const grams = num((entry.quantity as Row | undefined)?.grams);
    switch (entry.nutrient) {
      case 'PROTEIN':
        out.protein = grams;
        break;
      case 'DIETARY_FIBER':
        out.fiber = grams;
        break;
      case 'SODIUM':
        out.sodium = grams;
        break;
      case 'SUGAR':
        out.sugar = grams;
        break;
    }
  }
  return out;
}

/** Meal slot → API enum, falling back to ANYTIME for anything unmapped. */
function googleMealType(mealType: string): string {
  return MEAL_TYPE_TO_GOOGLE[mealType] ?? 'ANYTIME';
}

/** Nominal clock hour for each meal slot, so entries land in a sensible order. */
const MEAL_HOUR: Record<string, number> = {
  Breakfast: 8,
  MorningSnack: 10,
  Lunch: 12,
  AfternoonSnack: 15,
  Dinner: 19,
  Anytime: 12,
};

/**
 * A nutrition log needs an interval — the API has no date-only form — so each
 * meal slot is anchored at a nominal hour and given a 30-minute window.
 */
function mealInterval(date: string, mealType: string): Record<string, unknown> {
  const hh = String(MEAL_HOUR[mealType] ?? 12).padStart(2, '0');
  return { startTime: `${date}T${hh}:00:00Z`, endTime: `${date}T${hh}:30:00Z` };
}

/** A zero-width interval for point-in-time logs such as hydration. */
function instantInterval(date: string): Record<string, unknown> {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const at = `${date}T${hh}:${mm}:00Z`;
  return { startTime: at, endTime: at };
}

/** `ObservationSampleTime` for a date plus optional `HH:mm:ss`. */
function sampleTime(date: string, time?: string): Record<string, unknown> {
  return { physicalTime: `${date}T${time ?? '12:00:00'}Z` };
}

/** Epoch millis → RFC-3339 with whole seconds (the API rejects fractions). */
function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}
