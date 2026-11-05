import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { bumpCacheGeneration, cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, today } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { ExerciseLogSchema } from '../../providers/types';
import { DAILY_SUMMARY_CACHE, EXERCISE_LIST_CACHE } from '../read/activity';

const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

export function registerActivityWriteTool(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'log_activity',
    {
      title: 'Log a manual exercise / activity',
      description:
        'Record a workout that Fitbit did not auto-detect. Provide either `activityId` (Fitbit activity catalog) or `activityName` + `manualCalories`. Duration must be in milliseconds.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (server timezone).').optional(),
        startTime: z.string().regex(TIME_RE, 'Expected HH:mm:ss').describe('HH:mm:ss, local time.'),
        durationMs: z
          .number()
          .int()
          .positive()
          .describe('Duration of the activity in milliseconds.'),
        activityId: z.number().int().optional().describe('Fitbit activity catalog id.'),
        activityName: z
          .string()
          .optional()
          .describe('Free-text name (e.g. "Yoga"). Required if `activityId` is not set.'),
        manualCalories: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('kcal burned. Required when using `activityName`.'),
        distanceKm: z.number().nonnegative().optional().describe('Distance in kilometres.'),
      },
      outputSchema: ExerciseLogSchema.shape,
    },
    async (input) => {
      try {
        const date = input.date ?? today();
        assertIsoDate(date, 'date');
        if (!input.activityId && !input.activityName) {
          throw new RangeError('Either activityId or activityName must be provided.');
        }
        if (input.activityName && input.manualCalories === undefined) {
          throw new RangeError('manualCalories is required when using activityName.');
        }
        const entry = await provider.logActivity({ ...input, date });
        await Promise.all([
          invalidate(env, cacheKey(DAILY_SUMMARY_CACHE, { date })),
          bumpCacheGeneration(env, EXERCISE_LIST_CACHE),
        ]);
        return {
          structuredContent: entry,
          content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_activity_log',
    {
      title: 'Delete an activity / exercise log entry',
      description:
        'Remove a previously logged exercise by its logId (from log_activity output or from get_exercise_list[].logId).',
      inputSchema: {
        logId: z.number().int().describe('Activity logId.'),
        date: z
          .string()
          .describe('YYYY-MM-DD the entry was logged under. Used to invalidate caches.')
          .optional(),
      },
      outputSchema: { deleted: z.boolean(), logId: z.number() },
    },
    async ({ logId, date }) => {
      try {
        await provider.deleteActivityLog(logId);
        const d = date ?? today();
        assertIsoDate(d, 'date');
        await Promise.all([
          invalidate(env, cacheKey(DAILY_SUMMARY_CACHE, { date: d })),
          bumpCacheGeneration(env, EXERCISE_LIST_CACHE),
        ]);
        return {
          structuredContent: { deleted: true, logId },
          content: [{ type: 'text', text: `Deleted activity log ${logId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
