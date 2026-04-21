import { z } from 'zod';
import type { BodyFatLog, BodyLog, LogBodyFatInput, LogWeightInput, WeightLog } from '../types';
import { BodyFatLogSchema, WeightLogSchema } from '../types';
import type { FitbitClient } from './client';

const WeightResponseSchema = z.object({
  weight: z.array(WeightLogSchema).optional(),
});
const FatResponseSchema = z.object({
  fat: z.array(BodyFatLogSchema).optional(),
});

/**
 * Fitbit splits weight and body-fat into two endpoints; we fetch both
 * in parallel and return the merged BodyLog shape.
 */
export async function getBodyLog(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<BodyLog> {
  const [weightRes, fatRes] = await Promise.all([
    client.requestJson(WeightResponseSchema, {
      path: `/1/user/-/body/log/weight/date/${start}/${end}.json`,
    }),
    client.requestJson(FatResponseSchema, {
      path: `/1/user/-/body/log/fat/date/${start}/${end}.json`,
    }),
  ]);
  return {
    weight: weightRes.weight,
    fat: fatRes.fat,
  };
}

const CreateWeightLogResponseSchema = z.object({
  weightLog: WeightLogSchema,
});

export async function logWeight(client: FitbitClient, input: LogWeightInput): Promise<WeightLog> {
  const response = await client.requestJson(CreateWeightLogResponseSchema, {
    path: '/1/user/-/body/log/weight.json',
    method: 'POST',
    form: {
      date: input.date,
      weight: input.weightKg,
      time: input.time,
    },
  });
  return response.weightLog;
}

const CreateBodyFatLogResponseSchema = z.object({
  fatLog: BodyFatLogSchema,
});

export async function logBodyFat(
  client: FitbitClient,
  input: LogBodyFatInput,
): Promise<BodyFatLog> {
  const response = await client.requestJson(CreateBodyFatLogResponseSchema, {
    path: '/1/user/-/body/log/fat.json',
    method: 'POST',
    form: {
      date: input.date,
      fat: input.fatPercent,
      time: input.time,
    },
  });
  return response.fatLog;
}
