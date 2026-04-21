import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import {
  deletePreset,
  getPreset,
  listPresets,
  type MealPreset,
  savePreset,
  scalePresetNutrition,
} from '../../lib/presets';
import type { HealthProvider } from '../../providers/types';
import { FoodLogEntrySchema, MealType } from '../../providers/types';

const MealPresetSchema = z.object({
  name: z.string(),
  calories: z.number(),
  protein: z.number().optional(),
  carbs: z.number().optional(),
  fat: z.number().optional(),
  fiber: z.number().optional(),
  sodium: z.number().optional(),
  sugar: z.number().optional(),
  notes: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

async function invalidateFoodCaches(env: Env, date: string): Promise<void> {
  await invalidate(
    env,
    cacheKey('get_food_log', { date }),
    cacheKey('get_daily_summary', { date }),
  );
}

export function registerPresetTools(server: McpServer, provider: HealthProvider, env: Env): void {
  server.registerTool(
    'save_meal_preset',
    {
      title: 'Save a meal preset (reusable PFC profile)',
      description: [
        'Store a meal preset on the MCP server (Workers KV) so it can be',
        'logged later by name with full macros. Ideal for home-cooked batches',
        'like "自家製キーマカレー" where the calories AND protein/carbs/fat',
        'stay constant across servings.',
        '',
        "Why this exists: Fitbit's Create Food API only persists `calories`",
        'on a custom food and silently drops macros. Presets stored here are',
        'attached to each log_food call as nutritionalValues, so your PFC',
        'actually lands in Fitbit and is aggregated into daily totals.',
        '',
        'Values are for 1 serving. Use `amount` on log_preset to scale.',
        'Upserts by `name` (same name overwrites).',
      ].join('\n'),
      inputSchema: {
        name: z.string().describe('Unique preset name, e.g. "自家製キーマカレー".'),
        calories: z.number().int().min(0).describe('kcal per 1 serving.'),
        protein: z.number().nonnegative().optional().describe('grams per serving.'),
        carbs: z.number().nonnegative().optional().describe('grams per serving.'),
        fat: z.number().nonnegative().optional().describe('grams per serving.'),
        fiber: z.number().nonnegative().optional(),
        sodium: z.number().nonnegative().optional(),
        sugar: z.number().nonnegative().optional(),
        notes: z.string().optional().describe('Free text, e.g. "ご飯150g込み / 5食分作り置き"'),
      },
      outputSchema: MealPresetSchema.shape,
    },
    async (input) => {
      try {
        const preset = await savePreset(env, input);
        return {
          structuredContent: preset,
          content: [
            {
              type: 'text',
              text: `Saved preset "${preset.name}": ${preset.calories} kcal / P${preset.protein ?? '-'} C${preset.carbs ?? '-'} F${preset.fat ?? '-'} per serving`,
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'list_meal_presets',
    {
      title: 'List saved meal presets',
      description:
        'Return every meal preset saved on this MCP server, sorted by most-recently-updated. Call this first when the user says "X を記録して" to check if X is already a preset.',
      inputSchema: {},
      outputSchema: { presets: z.array(MealPresetSchema) },
    },
    async () => {
      try {
        const presets = await listPresets(env);
        return {
          structuredContent: { presets },
          content: [
            {
              type: 'text',
              text:
                presets.length === 0
                  ? 'No meal presets saved yet.'
                  : presets
                      .map(
                        (p) =>
                          `• ${p.name} — ${p.calories} kcal (P${p.protein ?? '-'} / C${p.carbs ?? '-'} / F${p.fat ?? '-'})${p.notes ? ` — ${p.notes}` : ''}`,
                      )
                      .join('\n'),
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'delete_meal_preset',
    {
      title: 'Delete a meal preset',
      description: 'Remove a saved meal preset by name. Prior log entries are NOT affected.',
      inputSchema: {
        name: z.string().describe('Preset name to delete.'),
      },
      outputSchema: { deleted: z.boolean(), name: z.string() },
    },
    async ({ name }) => {
      try {
        const deleted = await deletePreset(env, name);
        return {
          structuredContent: { deleted, name },
          content: [
            {
              type: 'text',
              text: deleted ? `Deleted preset "${name}".` : `Preset "${name}" not found.`,
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'log_preset',
    {
      title: 'Log a meal using a saved preset',
      description: [
        'Record a food-log entry from a previously-saved preset. Internally',
        'looks up the preset, multiplies its values by `amount`, then calls',
        'log_food with foodName + calories + all non-null macros — so Fitbit',
        'stores full PFC and honours the requested mealType.',
        '',
        'Workflow: save_meal_preset once → log_preset whenever you eat it.',
      ].join('\n'),
      inputSchema: {
        name: z.string().describe('Preset name saved via save_meal_preset.'),
        mealType: MealType,
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        amount: z
          .number()
          .positive()
          .describe('Serving multiplier. Default 1. Use 0.5 for half, 2 for double.')
          .optional(),
      },
      outputSchema: FoodLogEntrySchema.shape,
    },
    async ({ name, mealType, date, amount }) => {
      try {
        const preset: MealPreset | null = await getPreset(env, name);
        if (!preset) {
          throw new Error(
            `Meal preset "${name}" not found. Use list_meal_presets to see what's saved.`,
          );
        }
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const multiplier = amount ?? 1;
        const scaled = scalePresetNutrition(preset, multiplier);
        const entry = await provider.logFood({
          date: d,
          mealType,
          foodName: preset.name,
          calories: scaled.calories ?? preset.calories,
          amount: 1,
          unitName: 'serving',
          nutritionalValues: {
            protein: scaled.protein,
            carbs: scaled.carbs,
            fat: scaled.fat,
            fiber: scaled.fiber,
            sodium: scaled.sodium,
            sugar: scaled.sugar,
          },
        });
        await invalidateFoodCaches(env, d);
        return {
          structuredContent: entry,
          content: [
            {
              type: 'text',
              text: `Logged "${preset.name}" × ${multiplier} (${scaled.calories} kcal) for ${mealType} on ${d}.\n\n${JSON.stringify(entry, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
