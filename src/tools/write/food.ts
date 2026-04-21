import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import {
  CustomFoodSchema,
  FoodLogEntrySchema,
  MealType,
  NutritionalValuesSchema,
  WaterLogEntrySchema,
} from '../../providers/types';

async function invalidateFoodCaches(env: Env, date: string): Promise<void> {
  await invalidate(
    env,
    cacheKey('get_food_log', { date }),
    cacheKey('get_daily_summary', { date }),
  );
}

export function registerFoodWriteTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  // ---- log_food: single-item write ----
  server.registerTool(
    'log_food',
    {
      title: 'Log a single food entry',
      description:
        'Record one food item to Fitbit. Two modes: (1) pass `foodName` + `calories` for a plain-text entry (bypasses the 2025/11 Search Foods outage, mealType is honoured); (2) pass `foodId` + `unitId` (from a prior create_custom_food) to reuse a saved meal — note that Fitbit may force `mealTypeId` to Anytime (7) for custom foods, verify before relying on it for morning/lunch/dinner analysis. Exactly one of foodName/foodId is required.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        mealType: MealType,
        foodName: z
          .string()
          .describe('Free-text name, e.g. "おにぎり". Exclusive with foodId.')
          .optional(),
        calories: z
          .number()
          .int()
          .min(0)
          .describe('kcal for the logged portion. Required when using foodName.')
          .optional(),
        foodId: z
          .number()
          .int()
          .describe('Fitbit foodId from create_custom_food. Exclusive with foodName.')
          .optional(),
        unitId: z
          .number()
          .int()
          .describe(
            'Fitbit unit id (copy from create_custom_food.defaultUnit.id). Required when using foodId.',
          )
          .optional(),
        amount: z.number().positive().describe('Portion count. Default 1.').optional(),
        unitName: z
          .string()
          .describe('Free-text unit, e.g. "piece", "bowl". Default "serving". foodName only.')
          .optional(),
        brand: z.string().optional(),
        nutritionalValues: NutritionalValuesSchema.optional(),
      },
      outputSchema: FoodLogEntrySchema.shape,
    },
    async (input) => {
      try {
        const date = input.date ?? todayJst();
        assertIsoDate(date, 'date');
        const entry = await provider.logFood({ ...input, date });
        await invalidateFoodCaches(env, date);
        return {
          structuredContent: entry,
          content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  // ---- log_meal_photo: multi-item write, the primary mobile tool ----
  server.registerTool(
    'log_meal_photo',
    {
      title: 'Log a meal analyzed from a photo',
      description: [
        'Record a meal composed of multiple items. Intended use:',
        'user attaches a meal photo to Claude → Claude visually identifies',
        'each item and estimates portion / calories / macros → calls this',
        'tool ONCE with the full `items` list. Each item becomes a separate',
        'Fitbit food-log entry under the same `mealType` and `date`.',
        '',
        'Guidance for generating `items[]`:',
        "- `name` in the user's language (Japanese OK).",
        '- Include `estimatedGrams` whenever a portion size is visible.',
        '- `calories` is required (kcal). Round to nearest 5.',
        '- Include macros (`protein` / `carbs` / `fat`) when you can see',
        "  them; leave undefined if you can't estimate.",
        '- Include `confidence` so the user can sanity-check.',
        '',
        'Users can call `delete_food_log` on individual logIds if they',
        'disagree with an item.',
      ].join('\n'),
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        mealType: MealType,
        items: z
          .array(
            z.object({
              name: z.string(),
              estimatedGrams: z.number().positive().optional(),
              calories: z.number().int().min(0),
              protein: z.number().nonnegative().optional(),
              carbs: z.number().nonnegative().optional(),
              fat: z.number().nonnegative().optional(),
              confidence: z.enum(['high', 'medium', 'low']).optional(),
            }),
          )
          .min(1),
        notes: z.string().optional(),
      },
      outputSchema: {
        entries: z.array(FoodLogEntrySchema),
        mealType: MealType,
        date: z.string(),
        notes: z.string().optional(),
      },
    },
    async ({ date, mealType, items, notes }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const entries = await provider.logMeal({ date: d, mealType, items, notes });
        await invalidateFoodCaches(env, d);
        return {
          structuredContent: { entries, mealType, date: d, notes },
          content: [
            {
              type: 'text',
              text: `Logged ${entries.length} item(s) for ${mealType} on ${d}.\n\n${JSON.stringify(entries, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  // ---- log_water ----
  server.registerTool(
    'log_water',
    {
      title: 'Log water intake (ml)',
      description: 'Record water consumption in millilitres for the given date.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        amountMl: z.number().positive().describe('Millilitres.'),
      },
      outputSchema: WaterLogEntrySchema.shape,
    },
    async ({ date, amountMl }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const entry = await provider.logWater({ date: d, amountMl });
        await invalidateFoodCaches(env, d);
        return {
          structuredContent: entry,
          content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  // ---- delete_food_log ----
  server.registerTool(
    'delete_food_log',
    {
      title: 'Delete a Fitbit food-log entry',
      description:
        'Remove a previously logged food entry by its logId (from log_food or log_meal_photo output). Use this to undo a mistake.',
      inputSchema: {
        logId: z
          .number()
          .int()
          .describe('logId returned from a prior log_food / log_meal_photo call.'),
        date: z
          .string()
          .describe(
            'YYYY-MM-DD the entry was logged under. Used to invalidate caches; if unknown, today (JST) is used and the cache may lag briefly.',
          )
          .optional(),
      },
      outputSchema: { deleted: z.boolean(), logId: z.number() },
    },
    async ({ logId, date }) => {
      try {
        await provider.deleteFoodLog(logId);
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        await invalidateFoodCaches(env, d);
        return {
          structuredContent: { deleted: true, logId },
          content: [{ type: 'text', text: `Deleted food log ${logId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_water_log',
    {
      title: 'Delete a water log entry',
      description:
        'Remove a previously logged water entry by its logId (from log_water output or from get_food_log.water.water[].logId).',
      inputSchema: {
        logId: z.number().int().describe('Water logId.'),
        date: z
          .string()
          .describe('YYYY-MM-DD the entry was logged under. Used to invalidate caches.')
          .optional(),
      },
      outputSchema: { deleted: z.boolean(), logId: z.number() },
    },
    async ({ logId, date }) => {
      try {
        await provider.deleteWaterLog(logId);
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        await invalidateFoodCaches(env, d);
        return {
          structuredContent: { deleted: true, logId },
          content: [{ type: 'text', text: `Deleted water log ${logId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  // ---- create_custom_food: register a private, reusable food ----
  server.registerTool(
    'create_custom_food',
    {
      title: 'Create a private custom food',
      description: [
        'Register a reusable custom food on Fitbit. Ideal for home-cooked',
        'batches ("自家製キーマカレー" / "母のカレー") so you can log them',
        'later by foodId instead of re-entering calories and macros each time.',
        'Returns `foodId` (and `defaultUnit.id` to pass as unitId) — save the',
        'pair and use them with log_food.',
        '',
        'Caveat: Fitbit documents that mealTypeId is stored as Anytime (7)',
        'for custom-food log entries regardless of the value sent. If your',
        'workflow cares about breakfast/lunch/dinner segmentation, prefer',
        'log_food with plain `foodName` (and a meal preset kept client-side).',
      ].join('\n'),
      inputSchema: {
        name: z.string().describe('Display name, e.g. "自家製キーマカレー".'),
        calories: z
          .number()
          .int()
          .min(0)
          .describe('kcal PER default serving (defaultServingSize below).'),
        defaultServingSize: z
          .number()
          .positive()
          .describe('Portion count the calories/macros correspond to. Default 1.')
          .optional(),
        formType: z.enum(['LIQUID', 'DRY']).describe('Optional. Default DRY.').optional(),
        description: z.string().optional(),
        brand: z.string().optional(),
        nutritionalValues: NutritionalValuesSchema.optional(),
      },
      outputSchema: CustomFoodSchema.shape,
    },
    async (input) => {
      try {
        const food = await provider.createCustomFood(input);
        return {
          structuredContent: food,
          content: [
            {
              type: 'text',
              text: [
                `Created custom food "${input.name}".`,
                `foodId: ${food.foodId}`,
                `unitId: ${food.defaultUnit?.id ?? 'n/a'}`,
                '',
                JSON.stringify(food, null, 2),
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  // ---- delete_custom_food: remove a previously created custom food ----
  server.registerTool(
    'delete_custom_food',
    {
      title: 'Delete a private custom food',
      description:
        'Remove a custom food previously created via create_custom_food. Existing food-log entries that referenced this foodId are NOT deleted — use delete_food_log for those.',
      inputSchema: {
        foodId: z.number().int().describe('foodId from create_custom_food.'),
      },
      outputSchema: { deleted: z.boolean(), foodId: z.number() },
    },
    async ({ foodId }) => {
      try {
        await provider.deleteCustomFood(foodId);
        return {
          structuredContent: { deleted: true, foodId },
          content: [{ type: 'text', text: `Deleted custom food ${foodId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
