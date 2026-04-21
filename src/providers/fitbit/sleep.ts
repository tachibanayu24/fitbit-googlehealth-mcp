import { z } from 'zod';
import type { LogSleepInput, SleepLog } from '../types';
import { SleepLogSchema } from '../types';
import type { FitbitClient } from './client';

const SleepResponseSchema = z.object({
  sleep: z.array(SleepLogSchema),
});

export async function getSleep(client: FitbitClient, date: string): Promise<SleepLog[]> {
  const response = await client.requestJson(SleepResponseSchema, {
    path: `/1.2/user/-/sleep/date/${date}.json`,
  });
  return response.sleep;
}

export async function getSleepRange(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<SleepLog[]> {
  const response = await client.requestJson(SleepResponseSchema, {
    path: `/1.2/user/-/sleep/date/${start}/${end}.json`,
  });
  return response.sleep;
}

const CreateSleepLogResponseSchema = z.object({
  sleep: SleepLogSchema,
});

export async function logSleep(client: FitbitClient, input: LogSleepInput): Promise<SleepLog> {
  const response = await client.requestJson(CreateSleepLogResponseSchema, {
    path: '/1.2/user/-/sleep.json',
    method: 'POST',
    form: {
      startTime: input.startTime,
      duration: input.durationMs,
      date: input.date,
    },
  });
  return response.sleep;
}

export async function deleteSleepLog(client: FitbitClient, logId: number): Promise<void> {
  await client.requestText({
    path: `/1.2/user/-/sleep/${logId}.json`,
    method: 'DELETE',
  });
}
