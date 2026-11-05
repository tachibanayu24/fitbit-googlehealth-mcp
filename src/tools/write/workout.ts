import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { EXERCISE_CACHE_GROUP } from '../../insights/data';
import { forgetReports } from '../../insights/report';
import { bumpCacheGeneration, cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, today } from '../../lib/date';
import { toolErrorResult, UnsupportedOperationError } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { ExerciseLogSchema, WORKOUT_TYPES } from '../../providers/types';
import { DAILY_SUMMARY_CACHE, EXERCISE_LIST_CACHE } from '../read/activity';

const WRITTEN_PREFIX = 'written:exercise:';

const TYPE_LABEL: Record<(typeof WORKOUT_TYPES)[number], string> = {
  WEIGHTLIFTING: 'Weights',
  STRENGTH_TRAINING: 'Strength training',
  CORE_TRAINING: 'Core',
  HIIT: 'HIIT',
  BADMINTON: 'Badminton',
  BOWLING: 'Bowling',
  WALKING: 'Walk',
  RUNNING: 'Run',
};

async function refreshCaches(env: Env, date: string): Promise<void> {
  await Promise.all([
    invalidate(env, cacheKey(DAILY_SUMMARY_CACHE, { date })),
    bumpCacheGeneration(env, EXERCISE_LIST_CACHE),
    bumpCacheGeneration(env, EXERCISE_CACHE_GROUP),
    forgetReports(env, date),
  ]);
}

export function registerWorkoutWriteTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  const logWorkout = provider.logWorkout?.bind(provider);
  const deleteWorkout = provider.deleteWorkout?.bind(provider);
  if (!logWorkout || !deleteWorkout) return;

  server.registerTool(
    'log_workout',
    {
      title: 'Save a workout to Google Health / Fitbit',
      description:
        'Saves a workout the band did not detect to Google Health, so it shows in the Fitbit and ' +
        'Google Health apps. Sessions the band never records, such as gym work, should be saved ' +
        'when they end. Times are local; sets and reps can go in the notes. Refuses if ' +
        'the times overlap a workout that is already logged.',
      inputSchema: {
        date: z.string().optional().describe('YYYY-MM-DD the workout started. Omit for today.'),
        start: z.string().describe('Local start time, HH:MM in 24 hours, e.g. 20:15.'),
        end: z.string().describe('Local end time, HH:MM. Past midnight rolls to the next day.'),
        type: z.enum(WORKOUT_TYPES).default('WEIGHTLIFTING').describe('Default WEIGHTLIFTING.'),
        notes: z.string().max(2000).optional().describe('Free-text notes, e.g. sets and reps.'),
      },
      outputSchema: ExerciseLogSchema.shape,
    },
    async ({ date, start, end, type, notes }) => {
      try {
        const day = date ?? today();
        assertIsoDate(day, 'date');
        // Google shows its own name for the type.
        const saved = await logWorkout({
          date: day,
          start,
          end,
          exerciseType: type,
          name: TYPE_LABEL[type],
          notes,
        });
        if (saved.exerciseId) {
          // Remember which workouts this connector wrote, so delete_workout never
          // removes one the band recorded itself.
          await env.CACHE.put(
            `${WRITTEN_PREFIX}${saved.exerciseId}`,
            JSON.stringify({ date: day, savedAt: new Date().toISOString() }),
          );
        }
        await refreshCaches(env, day);
        return {
          structuredContent: saved,
          content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_workout',
    {
      title: 'Delete a workout saved with log_workout',
      description:
        'Removes a workout that log_workout saved, by its exerciseId, to fix a mistake. ' +
        'Workouts the band recorded cannot be deleted here.',
      inputSchema: {
        exerciseId: z.string().describe('exerciseId from log_workout or get_exercise_list.'),
        date: z.string().optional().describe('YYYY-MM-DD of the workout, to refresh that day.'),
      },
      outputSchema: { deleted: z.boolean(), exerciseId: z.string() },
    },
    async ({ exerciseId, date }) => {
      try {
        const key = `${WRITTEN_PREFIX}${exerciseId}`;
        if ((await env.CACHE.get(key)) === null) {
          throw new UnsupportedOperationError(
            `Workout ${exerciseId} was not saved by log_workout, so it is left alone.`,
            'Delete workouts the band recorded in the Google Health app.',
          );
        }
        await deleteWorkout(exerciseId);
        await env.CACHE.delete(key);
        const day = date ?? today();
        assertIsoDate(day, 'date');
        await refreshCaches(env, day);
        return {
          structuredContent: { deleted: true, exerciseId },
          content: [{ type: 'text', text: `Deleted workout ${exerciseId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
