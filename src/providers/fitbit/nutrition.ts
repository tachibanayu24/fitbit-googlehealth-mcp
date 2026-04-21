import { z } from 'zod';
import type {
  FoodLog,
  FoodLogEntry,
  LogFoodInput,
  LogMealInput,
  LogWaterInput,
  MealTypeT,
  WaterLogEntry,
} from '../types';
import { FoodLogEntrySchema, FoodLogSchema, WaterLogEntrySchema } from '../types';
import type { FitbitClient } from './client';

export async function getFoodLog(client: FitbitClient, date: string): Promise<FoodLog> {
  return client.requestJson(FoodLogSchema, {
    path: `/1/user/-/foods/log/date/${date}.json`,
  });
}

const MEAL_TYPE_ID: Record<MealTypeT, number> = {
  Breakfast: 1,
  MorningSnack: 2,
  Lunch: 3,
  AfternoonSnack: 4,
  Dinner: 5,
  Anytime: 7,
};

const CreateFoodLogResponseSchema = z.object({
  foodLog: FoodLogEntrySchema,
});

/** Fitbit food-unit id for "serving" — required in every foodName log body. */
const FITBIT_UNIT_SERVING = 304;

/**
 * Empirically verified nutrient field names on POST /1/user/-/foods/log.json
 * as of 2026-04 (see scripts/diagnose-food-log.ts). Fitbit silently ignores
 * any key that doesn't match exactly — e.g. `totalCarbs` stores as 0, only
 * `totalCarbohydrate` actually persists.
 */
export async function logFood(client: FitbitClient, input: LogFoodInput): Promise<FoodLogEntry> {
  const form: Record<string, string | number | undefined> = {
    foodName: input.foodName,
    mealTypeId: MEAL_TYPE_ID[input.mealType],
    unitId: FITBIT_UNIT_SERVING,
    amount: input.amount ?? 1,
    date: input.date,
    calories: input.calories,
    brandName: input.brand,
  };
  const n = input.nutritionalValues;
  if (n) {
    if (n.protein !== undefined) form.protein = n.protein;
    if (n.carbs !== undefined) form.totalCarbohydrate = n.carbs;
    if (n.fat !== undefined) form.totalFat = n.fat;
    if (n.fiber !== undefined) form.dietaryFiber = n.fiber;
    if (n.sodium !== undefined) form.sodium = n.sodium;
    if (n.sugar !== undefined) form.sugars = n.sugar;
  }

  const response = await client.requestJson(CreateFoodLogResponseSchema, {
    path: '/1/user/-/foods/log.json',
    method: 'POST',
    form,
  });
  return response.foodLog;
}

export async function logMeal(client: FitbitClient, input: LogMealInput): Promise<FoodLogEntry[]> {
  const results: FoodLogEntry[] = [];
  // Sequential (not Promise.all) so a partial failure surfaces with the
  // last successful item still recorded server-side, and Fitbit's
  // 150/h ceiling isn't hit with a burst.
  for (const item of input.items) {
    const entry = await logFood(client, {
      date: input.date,
      mealType: input.mealType,
      // Surface the estimated portion in the name itself so it's visible
      // in the Fitbit UI — Fitbit no longer accepts a free-text unitName.
      foodName: item.estimatedGrams ? `${item.name} (${item.estimatedGrams}g)` : item.name,
      calories: item.calories,
      amount: 1,
      nutritionalValues: {
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
      },
    });
    results.push(entry);
  }
  return results;
}

const CreateWaterLogResponseSchema = z.object({
  waterLog: WaterLogEntrySchema,
});

export async function logWater(client: FitbitClient, input: LogWaterInput): Promise<WaterLogEntry> {
  const response = await client.requestJson(CreateWaterLogResponseSchema, {
    path: '/1/user/-/foods/log/water.json',
    method: 'POST',
    query: {
      date: input.date,
      amount: input.amountMl,
      unit: 'ml',
    },
  });
  return response.waterLog;
}

export async function deleteFoodLog(client: FitbitClient, logId: number): Promise<void> {
  await client.requestText({
    path: `/1/user/-/foods/log/${logId}.json`,
    method: 'DELETE',
  });
}

export async function deleteWaterLog(client: FitbitClient, logId: number): Promise<void> {
  await client.requestText({
    path: `/1/user/-/foods/log/water/${logId}.json`,
    method: 'DELETE',
  });
}
