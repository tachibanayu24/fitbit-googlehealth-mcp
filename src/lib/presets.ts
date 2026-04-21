import type { Env } from '../env';
import type { NutritionalValues } from '../providers/types';

/**
 * Server-side meal presets, stored in the CACHE KV namespace with a
 * `preset:` prefix so a single home-cooked recipe can be logged later
 * without re-entering calories + macros every time.
 *
 * Why server-side? Fitbit's Create Food API only persists `calories`
 * on a custom food — any macros you submit are silently dropped.
 * Keeping the macro payload on our side lets us attach it to every
 * log_food call (foodName + nutritionalValues.*) so Fitbit actually
 * records the PFC numbers.
 */

const PRESET_PREFIX = 'preset:';

export type MealPreset = {
  name: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sodium?: number;
  sugar?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type UpsertMealPresetInput = {
  name: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sodium?: number;
  sugar?: number;
  notes?: string;
};

function keyFor(name: string): string {
  return `${PRESET_PREFIX}${name}`;
}

export async function savePreset(env: Env, input: UpsertMealPresetInput): Promise<MealPreset> {
  const now = Math.floor(Date.now() / 1000);
  const existingRaw = await env.CACHE.get(keyFor(input.name));
  const createdAt = existingRaw ? (JSON.parse(existingRaw) as MealPreset).createdAt : now;
  const preset: MealPreset = { ...input, createdAt, updatedAt: now };
  await env.CACHE.put(keyFor(input.name), JSON.stringify(preset));
  return preset;
}

export async function getPreset(env: Env, name: string): Promise<MealPreset | null> {
  const raw = await env.CACHE.get(keyFor(name));
  if (!raw) return null;
  return JSON.parse(raw) as MealPreset;
}

export async function listPresets(env: Env): Promise<MealPreset[]> {
  const list = await env.CACHE.list({ prefix: PRESET_PREFIX });
  const result: MealPreset[] = [];
  for (const entry of list.keys) {
    const raw = await env.CACHE.get(entry.name);
    if (raw) result.push(JSON.parse(raw) as MealPreset);
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deletePreset(env: Env, name: string): Promise<boolean> {
  const existing = await env.CACHE.get(keyFor(name));
  if (!existing) return false;
  await env.CACHE.delete(keyFor(name));
  return true;
}

export function scalePresetNutrition(preset: MealPreset, multiplier: number): NutritionalValues {
  const scale = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : Math.round(v * multiplier * 10) / 10;
  return {
    calories: Math.round(preset.calories * multiplier),
    protein: scale(preset.protein),
    carbs: scale(preset.carbs),
    fat: scale(preset.fat),
    fiber: scale(preset.fiber),
    sodium: scale(preset.sodium),
    sugar: scale(preset.sugar),
  };
}
