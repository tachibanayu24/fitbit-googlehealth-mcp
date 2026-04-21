import { z } from 'zod';
import type { SleepLog } from '../types';
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
