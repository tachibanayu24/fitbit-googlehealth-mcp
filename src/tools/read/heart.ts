import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import {
  assertIsoDate,
  cacheTtlForDate,
  cacheTtlForInstant,
  normalizeRange,
  parseZonedIso,
} from '../../lib/date';
import { toolErrorResult, UnsupportedOperationError } from '../../lib/errors';
import type { HealthProvider, HeartRatePoint } from '../../providers/types';
import { HeartRateDaySchema, HrResolutionSchema, IntradayDetailLevel } from '../../providers/types';

const FieldsSchema = z
  .enum(['full', 'compact'])
  .default('full')
  .describe(
    'full (default): points as {time_utc, time_local, bpm, ...}. compact: points as [time_local, bpm] without offset; the UTC offset is given once as utcOffset. About 4 times smaller.',
  );

export function registerHeartReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_heart_rate_range',
    {
      title: 'Heart rate across a date range',
      description:
        'Daily resting heart rate and heart-rate zones for each day in the range. ' +
        'Each zone is {name, min, max, minutes, source, minutesSource}. Bounds (bpm) are computed with the Fitbit Karvonen method from 220 - age and that day resting heart rate (source: computed); Peak ends at max heart rate. ' +
        'Minutes (up to 14-day ranges): Fat Burn, Cardio and Peak from Google zone minutes (minutesSource: google); Out of Range = minutes with heart-rate data minus the other zones (minutesSource: computed). minutesWithoutHeartRate = minutes of the day with no data. ' +
        'Past days are cached 1h, today 5 min.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(HeartRateDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(
          env,
          cacheKey('get_heart_rate_range.v2', range),
          () => provider.getHeartRateRange(range.start, range.end),
          { ttlSec: cacheTtlForDate(range.end) },
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_heart_rate_intraday',
    {
      title: 'Intraday heart rate for one day',
      description:
        'Heart-rate series for one local day, 00:00 to 24:00 in the user timezone, or a part of it with start_time/end_time. Every point has time_utc and time_local (ISO 8601 with offset). ' +
        'Real sampling: raw points come about every 1-5 s, about every 2 s during a workout. ' +
        '1sec returns these raw points as they are and adds no extra precision; 1min/5min/15min return per-bucket avg (bpm), min, max and sample count. ' +
        'WARNING: 1sec for a full day is about 35k points (about 3 MB) and does not fit in a model context. Use 1min for day views, or narrow the window with start_time/end_time and fields=compact. ' +
        'To analyse a workout, use get_exercise_heart_rate (series, summary and time in zones in one call). For any other window use get_heart_rate_range_intraday. ' +
        'heartRateZones: {name, min, max, minutes, source, minutesSource} for the whole day. Bounds are computed (Fitbit Karvonen, Peak ends at max heart rate). Minutes for Fat Burn, Cardio and Peak come from Google; Out of Range minutes are computed as minutes with heart-rate data minus the other zones. minutesWithoutHeartRate = minutes of the day with no data; all zone minutes plus it add up to the day length (for today: the minutes so far). Past days are cached 1h, today 5 min.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD, a local date in the user timezone.'),
        detailLevel: IntradayDetailLevel.describe(
          '1sec = raw samples; 1min / 5min / 15min = bucket averages.',
        ),
        start_time: z
          .string()
          .default('00:00')
          .describe('HH:MM local time. Start of the window inside the day. Default 00:00.'),
        end_time: z
          .string()
          .default('24:00')
          .describe(
            'HH:MM local time, 24:00 allowed. End of the window (exclusive). Default 24:00.',
          ),
        fields: FieldsSchema,
      },
    },
    async ({ date, detailLevel, start_time, end_time, fields }) => {
      try {
        assertIsoDate(date, 'date');
        const window = { startTime: start_time, endTime: end_time };
        const data = await getCached(
          env,
          cacheKey('get_heart_rate_intraday.v4', { date, detailLevel, start_time, end_time }),
          () => provider.getHeartRateIntraday(date, detailLevel, window),
          { ttlSec: cacheTtlForDate(date) },
        );
        return seriesResult(data, fields);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_heart_rate_range_intraday',
    {
      title: 'Heart rate for a time window',
      description:
        'Heart-rate series between two instants, at most 24 hours apart. start and end are ISO 8601 with an offset, e.g. 2026-09-26T11:15:00+05:00. ' +
        'resolution raw returns every stored sample (about every 1-5 s in a workout); 5s / 15s / 1min return per-bucket avg (bpm), min, max and sample count. ' +
        'Every point has time_utc and time_local. The summary gives avg, min, max, point count and the median interval between raw points. ' +
        'Windows that end before today are cached 1h, others 5 min.',
      inputSchema: {
        start: z.string().describe('ISO 8601 with offset, e.g. 2026-09-26T11:15:00+05:00'),
        end: z
          .string()
          .describe('ISO 8601 with offset. Inclusive to the second. At most 24 hours after start.'),
        resolution: HrResolutionSchema.optional().describe(
          'raw (default), 5s, 15s or 1min. For windows longer than a few hours use 1min.',
        ),
        fields: FieldsSchema,
      },
    },
    async ({ start, end, resolution, fields }) => {
      try {
        const getSeries = provider.getHeartRateSeries?.bind(provider);
        if (!getSeries) throw unsupported('get_heart_rate_range_intraday');
        const res = resolution ?? 'raw';
        const data = await getCached(
          env,
          cacheKey('get_heart_rate_range_intraday', { start, end, resolution: res }),
          () => getSeries(start, end, res),
          { ttlSec: cacheTtlForInstant(parseZonedIso(end, 'end')) },
        );
        return seriesResult(data, fields);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_exercise_heart_rate',
    {
      title: 'Heart rate for one workout',
      description:
        'Heart-rate series and summary for one workout from get_exercise_list. Pass exerciseId (preferred), or logId plus the workout date. ' +
        'Returns workout metadata (type, start/end in UTC and local time, active duration, distance, calories), the series, ' +
        'a summary (avg, min, max, point count, median interval and longest gap between raw points), time in zones, pause/stop events and laps with a heart-rate summary each. ' +
        'timeInZones = minutes in the Fitbit zones (Out of Range, Fat Burn, Cardio, Peak), with the same computed bounds as heartRateZones in the other tools unless max_hr is passed: Karvonen from max heart rate (220 - age, or max_hr) and resting heart rate. ' +
        'zones.google = zone durations that Google stores for the workout (whole minutes); zones.bevel = zones by percent of max heart rate (Bevel default). ' +
        'Zones in timeInZones and zones.bevel have min and max in bpm (Google gives no bounds for zones.google); the top zone (Peak, Zone 5) ends at max heart rate, and a sample above it still counts in the top zone. ' +
        'padding_minutes adds context before and after the workout to the series only; the summary and zones cover the workout itself. ' +
        'custom_zones = your own lower zone bounds (for example from your app); gives zones.custom. ' +
        'plan = the workout plan, for example "5w 3r [3r 3w]x4 8w 5w" (minutes + label, [..]xN repeats, 1:30r = 90 s); gives plan.segments with peak, avg, min and the end value for each segment, and plan.recovery with HRR60 (heart-rate drop 60 s after the last work segment). ' +
        'Segments follow each other from the workout start in active time (pauses are skipped). With plan, set include_points to false to get a short answer.',
      inputSchema: {
        exerciseId: z.string().optional().describe('exerciseId from get_exercise_list.'),
        logId: z.number().int().optional().describe('Numeric logId from get_exercise_list.'),
        date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD of the workout. Speeds up a logId lookup.'),
        resolution: HrResolutionSchema.optional().describe('5s (default), raw, 15s or 1min.'),
        padding_minutes: z.number().int().min(0).max(120).optional().describe('Default 0.'),
        max_hr: z
          .number()
          .int()
          .min(100)
          .max(240)
          .optional()
          .describe('Maximum heart rate for computed zones. Default 220 - age.'),
        custom_zones: z
          .array(
            z.object({
              name: z.string().max(40).optional(),
              min: z.number().int().min(30).max(240).describe('Lowest bpm of the zone.'),
            }),
          )
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Your zones, lowest first, e.g. [{"name":"Z1","min":94},...,{"name":"Z5","min":170}]. Each zone ends 1 bpm below the next one; the last ends at max heart rate.',
          ),
        plan: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Workout plan, e.g. "5w 3r [3r 3w]x4 8w 5w". Number = minutes, letters = label.',
          ),
        work_label: z
          .string()
          .max(20)
          .default('r')
          .describe('Plan label of work segments. HRR60 follows the last one.'),
        include_points: z
          .boolean()
          .default(true)
          .describe('False leaves points empty. Use false with plan on long workouts.'),
        fields: FieldsSchema,
      },
    },
    async ({
      exerciseId,
      logId,
      date,
      resolution,
      padding_minutes,
      max_hr,
      custom_zones,
      plan,
      work_label,
      include_points,
      fields,
    }) => {
      try {
        const getExerciseHr = provider.getExerciseHeartRate?.bind(provider);
        if (!getExerciseHr) throw unsupported('get_exercise_heart_rate');
        if (date) assertIsoDate(date, 'date');
        const opts = {
          resolution: resolution ?? '5s',
          paddingMinutes: padding_minutes ?? 0,
          maxHr: max_hr,
          customZones: custom_zones,
          plan: plan?.trim() || undefined,
          workLabel: work_label ?? 'r',
          includePoints: include_points ?? true,
        };
        const ref = { exerciseId, logId, date };
        const data = await getCached(
          env,
          // String(array of objects) gives "[object Object]", so zones go in as JSON.
          cacheKey('get_exercise_heart_rate.v4', {
            ...ref,
            ...opts,
            customZones: custom_zones && JSON.stringify(custom_zones),
          }),
          () => getExerciseHr(ref, opts),
          { ttlSec: date ? cacheTtlForDate(date) : 300 },
        );
        return seriesResult(data, fields);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}

/**
 * Series payloads can hold tens of thousands of points. So they go out once,
 * as compact JSON text: no `structuredContent` copy and no output-schema check,
 * which would double the size and add CPU time on a free-plan Worker.
 */
function seriesResult(data: { points: HeartRatePoint[] }, fields?: 'full' | 'compact') {
  const out = fields === 'compact' ? compactPoints(data) : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
}

/**
 * Points as `[local time without offset, bpm]`. The offset of the first point
 * goes once into the root; a series that crosses a DST change keeps that
 * first offset in `utcOffset`.
 */
function compactPoints<T extends { points: HeartRatePoint[] }>(data: T) {
  const { points, ...rest } = data;
  return {
    ...rest,
    utcOffset: points[0]?.time_local.slice(19),
    pointFormat: ['time_local', 'bpm'],
    points: points.map((p) => [p.time_local.slice(0, 19), p.bpm]),
  };
}

function unsupported(tool: string): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `${tool} needs the Google Health provider.`,
    'Set HEALTH_PROVIDER = "google" in wrangler.toml.',
  );
}
