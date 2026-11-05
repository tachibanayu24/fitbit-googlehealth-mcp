import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheGeneration, cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, cacheTtlForDate, normalizeRange, today } from '../../lib/date';
import { toolErrorResult, UnsupportedOperationError } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import {
  ActivityResource,
  DailySummarySchema,
  ExerciseLogSchema,
  ExerciseTcxSchema,
  TimeSeriesSchema,
} from '../../providers/types';

/** Cache key name of get_daily_summary. Write tools clear it, so keep it in one place. */
export const DAILY_SUMMARY_CACHE = 'get_daily_summary.v2';

/** Cache group of get_exercise_list. Write tools bump its generation. */
export const EXERCISE_LIST_CACHE = 'get_exercise_list.v3';

/** Records shorter than this are flagged as probably started by accident. */
const ACCIDENTAL_SEC = 60;

export function registerActivityReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_daily_summary',
    {
      title: 'Daily activity summary',
      description:
        'Steps, calories out, distance, floors, active-minute buckets and resting heart rate for a single day. Cached for 1 hour. NOTE: the current day is still being aggregated and its totals will keep changing until it closes — prefer a previous day for trend analysis. Individual metrics come from separate upstream rollups, so one may be absent while the rest are present.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (server timezone).').optional(),
      },
      outputSchema: DailySummarySchema.shape,
    },
    async ({ date }) => {
      try {
        const d = date ?? today();
        assertIsoDate(d, 'date');
        const data = await getCached(
          env,
          cacheKey(DAILY_SUMMARY_CACHE, { date: d }),
          () => provider.getDailySummary(d),
          { ttlSec: cacheTtlForDate(d) },
        );
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_activity_timeseries',
    {
      title: 'Activity metric time series',
      description:
        'Daily values of one activity metric across a date range. Useful for trending steps, distance, calories. Cached 1h.',
      inputSchema: {
        resource: ActivityResource.describe(
          'Which metric. Common: steps, distance, calories, minutesVeryActive.',
        ),
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: TimeSeriesSchema.shape,
    },
    async ({ resource, start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const data = await getCached(
          env,
          cacheKey('get_activity_timeseries', { resource, ...range }),
          () => provider.getActivityTimeSeries(resource, range.start, range.end),
          { ttlSec: cacheTtlForDate(range.end) },
        );
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_exercise_list',
    {
      title: 'Exercise logs',
      description:
        'Exercise / activity logs (runs, walks, workouts), newest first. Filter by local dates with from / to (inclusive; default: the last 90 days up to today). ' +
        'Each entry has exerciseId (Google id, string) and logId (number), startTime / endTime in UTC, startTime_local / endTime_local with offset, activeDurationSec (moving time, pauses excluded), distance (km), calories, averageHeartRate, hasGps and hasLaps. ' +
        'Records shorter than min_duration_seconds (default 60) are usually accidental starts; they are hidden and counted in hiddenShortCount. With min_duration_seconds = 0 all records are returned, and records shorter than 60 s have suspected_accidental = true. ' +
        'Pass exerciseId to get_exercise_heart_rate or export_exercise_tcx. Past ranges are cached 1h, ranges that include today 5 min.',
      inputSchema: {
        from: z.string().optional().describe('YYYY-MM-DD, inclusive.'),
        to: z.string().optional().describe('YYYY-MM-DD, inclusive. Defaults to today.'),
        beforeDate: z.string().optional().describe('Legacy alias for `to`.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Entries to return after filtering. Default 20, max 100.'),
        min_duration_seconds: z
          .number()
          .int()
          .min(0)
          .default(ACCIDENTAL_SEC)
          .describe(
            'Records shorter than this are hidden and counted in hiddenShortCount. Default 60. 0 returns all records; records shorter than 60 s are then flagged suspected_accidental=true.',
          ),
      },
      outputSchema: {
        exercises: z.array(ExerciseLogSchema),
        hiddenShortCount: z.number(),
      },
    },
    async ({ from, to, beforeDate, limit, min_duration_seconds }) => {
      try {
        const end = to ?? beforeDate ?? today();
        assertIsoDate(end, 'to');
        if (from) assertIsoDate(from, 'from');
        const gen = await cacheGeneration(env, EXERCISE_LIST_CACHE);
        const all = await getCached(
          env,
          cacheKey(EXERCISE_LIST_CACHE, { from, to: end, gen }),
          () => provider.getExerciseList({ from, to: end }),
          { ttlSec: cacheTtlForDate(end) },
        );

        const minSec = min_duration_seconds;
        let hiddenShortCount = 0;
        const exercises = [];
        for (const ex of all) {
          const sec =
            ex.activeDurationSec ?? (ex.duration === undefined ? undefined : ex.duration / 1000);
          if (sec !== undefined && sec < minSec) {
            hiddenShortCount++;
            continue;
          }
          const accidental = sec !== undefined && sec < ACCIDENTAL_SEC;
          exercises.push(accidental ? { ...ex, suspected_accidental: true } : ex);
        }
        const data = { exercises: exercises.slice(0, limit), hiddenShortCount };
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'export_exercise_tcx',
    {
      title: 'Export a workout as TCX',
      description:
        'Downloads one workout as a TCX (Training Center XML) file through Google exportExerciseTcx. Pass exerciseId from get_exercise_list (or logId plus date). ' +
        'Needs the googlehealth.location.readonly scope; without it Google answers 403. ' +
        'Workouts without GPS (hasGps = false) export only with partial_data = true (default) and may have no per-second heart rate. ' +
        'Returns trackpoint counts and the XML, cut to max_chars. Cached 1h.',
      inputSchema: {
        exerciseId: z.string().optional().describe('exerciseId from get_exercise_list.'),
        logId: z.number().int().optional().describe('Numeric logId from get_exercise_list.'),
        date: z.string().optional().describe('YYYY-MM-DD of the workout, for a logId lookup.'),
        partial_data: z
          .boolean()
          .optional()
          .describe('Export even without GPS data. Default true.'),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(2_000_000)
          .optional()
          .describe('Cut the XML to this many characters. Default 100000.'),
      },
      outputSchema: ExerciseTcxSchema.shape,
    },
    async ({ exerciseId, logId, date, partial_data, max_chars }) => {
      try {
        const exportTcx = provider.exportExerciseTcx?.bind(provider);
        if (!exportTcx) {
          throw new UnsupportedOperationError(
            'export_exercise_tcx needs the Google Health provider.',
          );
        }
        if (date) assertIsoDate(date, 'date');
        const ref = { exerciseId, logId, date };
        const partialData = partial_data ?? true;
        const { tcx: xml, ...ids } = await getCached(
          env,
          cacheKey('export_exercise_tcx.v2', { ...ref, partialData }),
          () => exportTcx(ref, { partialData }),
        );
        const limitChars = max_chars ?? 100_000;
        const data = {
          ...ids,
          bytes: xml.length,
          trackpointCount: countTag(xml, '<Trackpoint>'),
          heartRateTrackpointCount: countTag(xml, '<HeartRateBpm'),
          hasPosition: xml.includes('<Position>'),
          truncated: xml.length > limitChars,
          tcx: xml.slice(0, limitChars),
        };
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}

function countTag(xml: string, tag: string): number {
  let n = 0;
  for (let i = xml.indexOf(tag); i !== -1; i = xml.indexOf(tag, i + tag.length)) n++;
  return n;
}
