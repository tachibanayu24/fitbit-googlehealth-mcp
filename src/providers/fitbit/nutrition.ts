import { z } from 'zod';
import type {
  CreateCustomFoodInput,
  CustomFood,
  FoodLog,
  FoodLogEntry,
  LogFoodInput,
  LogMealInput,
  LogWaterInput,
  MealTypeT,
  WaterLogEntry,
} from '../types';
import { CustomFoodSchema, FoodLogEntrySchema, FoodLogSchema, WaterLogEntrySchema } from '../types';
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

/** Fitbit food-unit id for "serving", used as a safe default. */
const FITBIT_UNIT_SERVING = 304;

export async function logFood(client: FitbitClient, input: LogFoodInput): Promise<FoodLogEntry> {
  const usingFoodId = input.foodId !== undefined;
  const usingFoodName = input.foodName !== undefined;
  if (usingFoodId === usingFoodName) {
    throw new RangeError('logFood: exactly one of foodId or foodName must be provided.');
  }

  const form: Record<string, string | number | undefined> = {
    mealTypeId: MEAL_TYPE_ID[input.mealType],
    date: input.date,
    amount: input.amount ?? 1,
  };

  if (usingFoodId) {
    if (input.unitId === undefined) {
      throw new RangeError('logFood: unitId is required when foodId is supplied.');
    }
    form.foodId = input.foodId;
    form.unitId = input.unitId;
  } else {
    form.foodName = input.foodName;
    if (input.calories === undefined) {
      throw new RangeError('logFood: calories is required when foodName is supplied.');
    }
    form.calories = input.calories;
    // Fitbit's /foods/log endpoint now rejects foodName posts without a
    // numeric `unitId` ("Missing or invalid food unit id: null."). `unitName`
    // is no longer accepted as a substitute. Default to the "serving"
    // food-unit id and let callers override via input.unitId.
    form.unitId = input.unitId ?? FITBIT_UNIT_SERVING;
    if (input.brand) form.brandName = input.brand;
    const n = input.nutritionalValues;
    if (n) {
      if (n.protein !== undefined) form['nutritionalValues.protein'] = n.protein;
      if (n.carbs !== undefined) form['nutritionalValues.carbs'] = n.carbs;
      if (n.fat !== undefined) form['nutritionalValues.fat'] = n.fat;
      if (n.fiber !== undefined) form['nutritionalValues.fiber'] = n.fiber;
      if (n.sodium !== undefined) form['nutritionalValues.sodium'] = n.sodium;
      if (n.sugar !== undefined) form['nutritionalValues.sugar'] = n.sugar;
    }
  }

  const response = await client.requestJson(CreateFoodLogResponseSchema, {
    path: '/1/user/-/foods/log.json',
    method: 'POST',
    form,
  });
  return response.foodLog;
}

const CreateCustomFoodResponseSchema = z.object({
  food: CustomFoodSchema,
});

export async function createCustomFood(
  client: FitbitClient,
  input: CreateCustomFoodInput,
): Promise<CustomFood> {
  const form: Record<string, string | number | undefined> = {
    name: input.name,
    defaultFoodMeasurementUnitId: input.defaultFoodMeasurementUnitId ?? FITBIT_UNIT_SERVING,
    defaultServingSize: input.defaultServingSize ?? 1,
    calories: input.calories,
    formType: input.formType,
    description: input.description,
    brand: input.brand,
  };
  const n = input.nutritionalValues;
  if (n) {
    if (n.protein !== undefined) form['nutritionalValues.protein'] = n.protein;
    if (n.carbs !== undefined) form['nutritionalValues.carbs'] = n.carbs;
    if (n.fat !== undefined) form['nutritionalValues.fat'] = n.fat;
    if (n.fiber !== undefined) form['nutritionalValues.fiber'] = n.fiber;
    if (n.sodium !== undefined) form['nutritionalValues.sodium'] = n.sodium;
    if (n.sugar !== undefined) form['nutritionalValues.sugar'] = n.sugar;
  }

  const response = await client.requestJson(CreateCustomFoodResponseSchema, {
    path: '/1/user/-/foods.json',
    method: 'POST',
    form,
  });
  return response.food;
}

export async function deleteCustomFood(client: FitbitClient, foodId: number): Promise<void> {
  await client.requestText({
    path: `/1/user/-/foods/${foodId}.json`,
    method: 'DELETE',
  });
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
