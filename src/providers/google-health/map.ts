/**
 * Value coercion helpers for Google Health payloads.
 *
 * The API serialises every `int64` field as a JSON *string* (`"1250"`, not
 * `1250`), so anything numeric has to go through `num()` before it reaches a
 * schema that expects a number.
 */

/**
 * kebab-case data type id -> the camelCase key its payload sits under inside a
 * DataPoint. `daily-resting-heart-rate` becomes `dailyRestingHeartRate`.
 */
export function kebabToCamel(dataType: string): string {
  return dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function numOr(v: unknown, fallback: number): number {
  return num(v) ?? fallback;
}

/** `{ year, month, day }` → `YYYY-MM-DD`. */
export function fromCivilDate(d: unknown): string | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const { year, month, day } = d as { year?: number; month?: number; day?: number };
  if (!year || !month || !day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `{ date: {...}, time: {...} }` → ISO-ish local timestamp. */
export function fromCivilDateTime(dt: unknown): string | undefined {
  if (!dt || typeof dt !== 'object') return undefined;
  const { date, time } = dt as { date?: unknown; time?: Record<string, number> };
  const d = fromCivilDate(date);
  if (!d) return undefined;
  if (!time) return d;
  const hh = String(time.hours ?? 0).padStart(2, '0');
  const mm = String(time.minutes ?? 0).padStart(2, '0');
  const ss = String(time.seconds ?? 0).padStart(2, '0');
  return `${d}T${hh}:${mm}:${ss}`;
}

/**
 * Best-effort local date for a data point, preferring the civil (wall-clock)
 * fields so a reading is attributed to the day the user experienced it rather
 * than the UTC day.
 */
export function pointDate(value: Record<string, unknown>): string | undefined {
  const interval = value.interval as Record<string, unknown> | undefined;
  if (interval) {
    return (
      fromCivilDate((interval.civilStartTime as { date?: unknown })?.date) ??
      (typeof interval.startTime === 'string' ? interval.startTime.slice(0, 10) : undefined)
    );
  }
  const sample = value.sampleTime as Record<string, unknown> | undefined;
  if (sample) {
    return (
      fromCivilDate((sample.civilTime as { date?: unknown })?.date) ??
      (typeof sample.physicalTime === 'string' ? sample.physicalTime.slice(0, 10) : undefined)
    );
  }
  return fromCivilDate(value.date);
}

/** Full local timestamp for a sample-time data point. */
export function pointTimestamp(value: Record<string, unknown>): string | undefined {
  const sample = value.sampleTime as Record<string, unknown> | undefined;
  if (sample) {
    return (
      fromCivilDateTime(sample.civilTime) ??
      (typeof sample.physicalTime === 'string' ? sample.physicalTime : undefined)
    );
  }
  const interval = value.interval as Record<string, unknown> | undefined;
  if (interval) {
    return (
      fromCivilDateTime(interval.civilStartTime) ??
      (typeof interval.startTime === 'string' ? interval.startTime : undefined)
    );
  }
  return undefined;
}

/** `"3600s"` → 3600000 ms. Google serialises durations as second-strings. */
export function durationMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v * 1000;
  if (typeof v !== 'string') return undefined;
  const n = Number(v.endsWith('s') ? v.slice(0, -1) : v);
  return Number.isFinite(n) ? Math.round(n * 1000) : undefined;
}

/**
 * A stable numeric id derived from a data point's resource `name`.
 *
 * The Fitbit-shaped tool schemas this server still exposes use numeric
 * `logId`s, but Google identifies a point by an opaque resource path. Delete
 * tools therefore take the full `name` string; this hash exists only so the
 * legacy numeric fields stay populated and stable across reads.
 */
export function nameToNumericId(name: unknown): number {
  if (typeof name !== 'string' || name === '') return 0;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Meal type mapping between this server's tool surface and the API enum.
 *
 * The API also offers a flat `SNACK`, but the two snack slots are mapped to
 * `BEFORE_LUNCH` / `BEFORE_DINNER` instead so morning and afternoon snacks
 * stay distinguishable when read back — `SNACK` would collapse both.
 */
export const MEAL_TYPE_TO_GOOGLE: Record<string, string> = {
  Breakfast: 'BREAKFAST',
  MorningSnack: 'BEFORE_LUNCH',
  Lunch: 'LUNCH',
  AfternoonSnack: 'BEFORE_DINNER',
  Dinner: 'DINNER',
  Anytime: 'ANYTIME',
};

/** Reverse mapping onto the numeric mealTypeId the existing tool schema uses. */
export const GOOGLE_TO_MEAL_TYPE_ID: Record<string, number> = {
  BEFORE_BREAKFAST: 1,
  BREAKFAST: 1,
  BEFORE_LUNCH: 2,
  LUNCH: 3,
  BEFORE_DINNER: 4,
  DINNER: 5,
  AFTER_DINNER: 5,
  SNACK: 4,
  ANYTIME: 7,
  MEAL_TYPE_UNSPECIFIED: 7,
};

/**
 * Nutrient enum names used by `NutrientQuantity.nutrient`, for the macros this
 * server reads and writes. Fat and carbohydrate are top-level fields on
 * `NutritionLog` (`totalFat` / `totalCarbohydrate`) rather than entries in
 * `nutrients[]`, so they are not listed here.
 */
export const NUTRIENT = {
  protein: 'PROTEIN',
  fiber: 'DIETARY_FIBER',
  sodium: 'SODIUM',
  sugar: 'SUGAR',
} as const;

/** Sleep stage enum → the lowercase level names the existing tool schema uses. */
export const SLEEP_STAGE_TO_LEVEL: Record<string, string> = {
  AWAKE: 'wake',
  LIGHT: 'light',
  DEEP: 'deep',
  REM: 'rem',
  ASLEEP: 'asleep',
  RESTLESS: 'restless',
};
