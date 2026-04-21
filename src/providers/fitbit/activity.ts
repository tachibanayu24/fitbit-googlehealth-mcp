import { z } from 'zod';
import type {
  ActivityResourceT,
  DailySummary,
  ExerciseLog,
  LogActivityInput,
  TimeSeries,
} from '../types';
import { DailySummarySchema, ExerciseLogSchema, TimeSeriesPointSchema } from '../types';
import type { FitbitClient } from './client';

export async function getDailySummary(client: FitbitClient, date: string): Promise<DailySummary> {
  return client.requestJson(DailySummarySchema, {
    path: `/1/user/-/activities/date/${date}.json`,
  });
}

/**
 * Fitbit's time-series endpoint keys the array by `activities-<resource>`,
 * so we parse with a record schema and pluck the expected key.
 */
const TimeSeriesResponseSchema = z.record(z.string(), z.array(TimeSeriesPointSchema));

export async function getActivityTimeSeries(
  client: FitbitClient,
  resource: ActivityResourceT,
  start: string,
  end: string,
): Promise<TimeSeries> {
  const raw = await client.requestJson(TimeSeriesResponseSchema, {
    path: `/1/user/-/activities/${resource}/date/${start}/${end}.json`,
  });
  const key = `activities-${resource}`;
  const points = raw[key] ?? [];
  return { resource, points };
}

const ExerciseListResponseSchema = z.object({
  activities: z.array(ExerciseLogSchema),
});

export async function getExerciseList(
  client: FitbitClient,
  opts: { beforeDate?: string; limit?: number } = {},
): Promise<ExerciseLog[]> {
  const response = await client.requestJson(ExerciseListResponseSchema, {
    path: '/1/user/-/activities/list.json',
    query: {
      beforeDate: opts.beforeDate,
      sort: 'desc',
      limit: Math.min(opts.limit ?? 10, 100),
      offset: 0,
    },
  });
  return response.activities;
}

const CreateActivityLogResponseSchema = z.object({
  activityLog: ExerciseLogSchema,
});

export async function logActivity(
  client: FitbitClient,
  input: LogActivityInput,
): Promise<ExerciseLog> {
  const response = await client.requestJson(CreateActivityLogResponseSchema, {
    path: '/1/user/-/activities.json',
    method: 'POST',
    form: {
      activityId: input.activityId,
      activityName: input.activityName,
      manualCalories: input.manualCalories,
      startTime: input.startTime,
      durationMillis: input.durationMs,
      date: input.date,
      distance: input.distanceKm,
      distanceUnit: input.distanceKm !== undefined ? 'Kilometer' : undefined,
    },
  });
  return response.activityLog;
}

export async function deleteActivityLog(client: FitbitClient, logId: number): Promise<void> {
  await client.requestText({
    path: `/1/user/-/activities/${logId}.json`,
    method: 'DELETE',
  });
}
