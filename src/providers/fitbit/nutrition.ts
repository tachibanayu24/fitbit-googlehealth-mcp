import type { FoodLog } from '../types';
import { FoodLogSchema } from '../types';
import type { FitbitClient } from './client';

export async function getFoodLog(client: FitbitClient, date: string): Promise<FoodLog> {
  return client.requestJson(FoodLogSchema, {
    path: `/1/user/-/foods/log/date/${date}.json`,
  });
}
