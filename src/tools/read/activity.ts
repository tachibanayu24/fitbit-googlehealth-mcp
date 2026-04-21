import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, normalizeRange, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import {
  ActivityResource,
  DailySummarySchema,
  ExerciseLogSchema,
  TimeSeriesSchema,
} from '../../providers/types';

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
        'Steps, calories out, distance, heart rate zones (resting + zone minutes), active-minute bucket totals for a single day. Cached for 1 hour. NOTE: values for the current JST day can be unstable until Fitbit finalises aggregation (e.g. negative `sedentaryMinutes`, or a huge `caloriesOut` on the Out of Range zone). Prefer querying a previous day for trending analysis.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
      },
      outputSchema: DailySummarySchema.shape,
    },
    async ({ date }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const data = await getCached(env, cacheKey('get_daily_summary', { date: d }), () =>
          provider.getDailySummary(d),
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
      title: 'Recent exercise logs',
      description:
        'Returns recent exercise / activity log entries (runs, walks, workouts) in reverse chronological order.',
      inputSchema: {
        beforeDate: z
          .string()
          .describe('YYYY-MM-DD. Returns entries before this date. Defaults to today (JST).')
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe('Number of entries to return. Default 10, max 100.')
          .optional(),
      },
      outputSchema: { exercises: z.array(ExerciseLogSchema) },
    },
    async ({ beforeDate, limit }) => {
      try {
        const bd = beforeDate ?? todayJst();
        assertIsoDate(bd, 'beforeDate');
        const exercises = await getCached(
          env,
          cacheKey('get_exercise_list', { beforeDate: bd, limit }),
          () => provider.getExerciseList({ beforeDate: bd, limit }),
        );
        return {
          structuredContent: { exercises },
          content: [{ type: 'text', text: JSON.stringify(exercises, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
