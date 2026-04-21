import { z } from 'zod';
import type { BodyLog } from '../types';
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
