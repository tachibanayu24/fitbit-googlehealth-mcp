import { z } from 'zod';

// ---------- Profile ----------
export const ProfileSchema = z.object({
  user: z.object({
    encodedId: z.string(),
    displayName: z.string().optional(),
    fullName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dateOfBirth: z.string().optional(),
    /** Google Health reports age directly; Fitbit reported a date of birth. */
    age: z.number().optional(),
    gender: z.string().optional(),
    height: z.number().optional(),
    heightUnit: z.string().optional(),
    weight: z.number().optional(),
    weightUnit: z.string().optional(),
    timezone: z.string().optional(),
    locale: z.string().optional(),
    memberSince: z.string().optional(),
    offsetFromUTCMillis: z.number().optional(),
    averageDailySteps: z.number().optional(),
  }),
});
export type Profile = z.infer<typeof ProfileSchema>;

// ---------- Device ----------
export const DeviceSchema = z.object({
  id: z.string(),
  deviceVersion: z.string().optional(),
  type: z.string().optional(),
  battery: z.string().optional(),
  batteryLevel: z.number().optional(),
  lastSyncTime: z.string().optional(),
  mac: z.string().optional(),
  features: z.array(z.string()).optional(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const DevicesResponseSchema = z.array(DeviceSchema);

// ---------- Heart rate zones (shared by daily summary + HR endpoints) ----------
export const HeartRateZoneSchema = z.object({
  name: z.string(),
  /** Bounds in bpm. Absent when resting heart rate or age is unknown, never 0. */
  min: z.number().optional(),
  max: z.number().optional(),
  minutes: z.number().optional(),
  caloriesOut: z.number().optional(),
  /** "computed" = bounds worked out here (Karvonen), not read from the API. */
  source: z.string().optional(),
  /** "google" = Google zone minutes; "computed" = worked out here (Out of Range). */
  minutesSource: z.string().optional(),
});
export type HeartRateZone = z.infer<typeof HeartRateZoneSchema>;

// ---------- Daily activity summary ----------
// Fitbit occasionally returns numeric fields as strings here (observed:
// sedentaryMinutes = "1440" on days with no activity). Use coerce to
// accept both shapes while keeping the typed output as number.
const NumOpt = z.coerce.number().optional();

export const DailySummarySchema = z.object({
  goals: z
    .object({
      activeMinutes: NumOpt,
      caloriesOut: NumOpt,
      distance: NumOpt,
      steps: NumOpt,
      floors: NumOpt,
    })
    .optional(),
  summary: z.object({
    steps: NumOpt,
    caloriesOut: NumOpt,
    caloriesBMR: NumOpt,
    activityCalories: NumOpt,
    distances: z.array(z.object({ activity: z.string(), distance: z.coerce.number() })).optional(),
    elevation: NumOpt,
    floors: NumOpt,
    fairlyActiveMinutes: NumOpt,
    lightlyActiveMinutes: NumOpt,
    sedentaryMinutes: NumOpt,
    veryActiveMinutes: NumOpt,
    restingHeartRate: NumOpt,
    heartRateZones: z.array(HeartRateZoneSchema).optional(),
    /** Minutes of the day without heart-rate data (watch off or not worn). */
    minutesWithoutHeartRate: NumOpt,
    marginalCalories: NumOpt,
  }),
});
export type DailySummary = z.infer<typeof DailySummarySchema>;

// ---------- Activity time series ----------
export const ActivityResource = z.enum([
  'steps',
  'distance',
  'calories',
  'caloriesBMR',
  'elevation',
  'floors',
  'minutesSedentary',
  'minutesLightlyActive',
  'minutesFairlyActive',
  'minutesVeryActive',
  'activityCalories',
]);
export type ActivityResourceT = z.infer<typeof ActivityResource>;

export const TimeSeriesPointSchema = z.object({
  dateTime: z.string(),
  value: z.union([z.string(), z.number()]),
});
export const TimeSeriesSchema = z.object({
  resource: ActivityResource,
  points: z.array(TimeSeriesPointSchema),
});
export type TimeSeries = z.infer<typeof TimeSeriesSchema>;

// ---------- Exercise log list ----------
export const ExerciseLogSchema = z.object({
  logId: z.number().optional(),
  /** Google data point id. Pass it to the exercise heart-rate and TCX tools. */
  exerciseId: z.string().optional(),
  activityName: z.string().optional(),
  exerciseType: z.string().optional(),
  activityTypeId: z.number().optional(),
  /** Start instant in UTC (`...Z`). */
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  /** Start as local wall clock with offset (`2026-09-26T11:15:20+05:00`). */
  startTime_local: z.string().optional(),
  endTime_local: z.string().optional(),
  /** Active duration in milliseconds (pauses excluded). */
  duration: z.number().optional(),
  activeDurationSec: z.number().optional(),
  calories: z.number().optional(),
  steps: z.number().optional(),
  distance: z.number().optional(),
  distanceUnit: z.string().optional(),
  averageHeartRate: z.number().optional(),
  hasGps: z.boolean().optional(),
  hasLaps: z.boolean().optional(),
  /** True when the record is shorter than `min_duration_seconds`. */
  suspected_accidental: z.boolean().optional(),
  heartRateZones: z.array(HeartRateZoneSchema).optional(),
});
export type ExerciseLog = z.infer<typeof ExerciseLogSchema>;

export type ExerciseListOptions = {
  /** Inclusive local dates. */
  from?: string;
  to?: string;
  /** Legacy alias for `to`. */
  beforeDate?: string;
  limit?: number;
};

// ---------- Heart rate range ----------
export const HeartRateDaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    restingHeartRate: z.number().optional(),
    heartRateZones: z.array(HeartRateZoneSchema).optional(),
    /** Minutes of the day without heart-rate data (watch off or not worn). */
    minutesWithoutHeartRate: z.number().optional(),
    customHeartRateZones: z.array(HeartRateZoneSchema).optional(),
  }),
});
export type HeartRateDay = z.infer<typeof HeartRateDaySchema>;

// ---------- Heart rate series (intraday, time range, exercise) ----------
export const IntradayDetailLevel = z.enum(['1sec', '1min', '5min', '15min']);
export type IntradayDetailLevelT = z.infer<typeof IntradayDetailLevel>;

export const HrResolutionSchema = z.enum(['raw', '5s', '15s', '1min']);
export type HrResolutionT = z.infer<typeof HrResolutionSchema>;

export const HeartRatePointSchema = z.object({
  time_utc: z.string(),
  time_local: z.string(),
  /** Raw value, or the rounded bucket average. */
  bpm: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  samples: z.number().optional(),
});
export type HeartRatePoint = z.infer<typeof HeartRatePointSchema>;

export const TimeWindowSchema = z.object({
  start_utc: z.string(),
  end_utc: z.string(),
  start_local: z.string(),
  end_local: z.string(),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const HeartRateSummarySchema = z.object({
  avg: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pointCount: z.number(),
  medianIntervalSec: z.number().optional(),
  maxGapSec: z.number().optional(),
});
export type HeartRateSummary = z.infer<typeof HeartRateSummarySchema>;

/** How zone bounds were worked out. The API does not report them. */
export const ZoneBasisSchema = z.object({
  source: z.literal('computed'),
  method: z.string(),
  maxHr: z.number(),
  maxHrSource: z.string(),
  restingHr: z.number(),
});
export type ZoneBasis = z.infer<typeof ZoneBasisSchema>;

export const HeartRateIntradaySchema = z.object({
  date: z.string(),
  timeZone: z.string().optional(),
  detailLevel: IntradayDetailLevel,
  window: TimeWindowSchema.optional(),
  restingHeartRate: z.number().optional(),
  heartRateZones: z.array(HeartRateZoneSchema).optional(),
  /** Minutes of the whole day without heart-rate data (watch off or not worn). */
  minutesWithoutHeartRate: z.number().optional(),
  zoneBasis: ZoneBasisSchema.optional(),
  summary: HeartRateSummarySchema.optional(),
  points: z.array(HeartRatePointSchema),
});
export type HeartRateIntraday = z.infer<typeof HeartRateIntradaySchema>;

/** Optional part of the day, as local HH:MM. `endTime` may be 24:00. */
export type IntradayWindow = { startTime?: string; endTime?: string };

export const HeartRateSeriesSchema = z.object({
  timeZone: z.string(),
  resolution: HrResolutionSchema,
  window: TimeWindowSchema,
  summary: HeartRateSummarySchema,
  points: z.array(HeartRatePointSchema),
});
export type HeartRateSeries = z.infer<typeof HeartRateSeriesSchema>;

export const ZoneTimeSchema = z.object({
  name: z.string(),
  /** Bounds in bpm, same meaning as in HeartRateZoneSchema. */
  min: z.number().optional(),
  max: z.number().optional(),
  seconds: z.number(),
  minutes: z.number().optional(),
  percent: z.number().optional(),
});

export const ExerciseLapSchema = z.object({
  index: z.number(),
  splitType: z.string().optional(),
  window: TimeWindowSchema,
  activeDurationSec: z.number().optional(),
  distanceKm: z.number().optional(),
  googleAverageHeartRate: z.number().optional(),
  heartRate: HeartRateSummarySchema,
});

export const ExerciseEventSchema = z.object({
  type: z.string(),
  time_utc: z.string(),
  time_local: z.string(),
});

export const ExerciseHeartRateSchema = z.object({
  exercise: ExerciseLogSchema.extend({ window: TimeWindowSchema }),
  timeZone: z.string(),
  resolution: HrResolutionSchema,
  paddingMinutes: z.number(),
  /** Summary over the session only; padding is excluded. */
  summary: HeartRateSummarySchema,
  /** Time in the user's Fitbit zones (Karvonen bounds), same bounds as heartRateZones elsewhere. */
  timeInZones: ZoneBasisSchema.extend({ zones: z.array(ZoneTimeSchema) }).optional(),
  zones: z.object({
    /** Zone durations reported by Google for this workout (whole minutes). */
    google: z.array(ZoneTimeSchema).optional(),
    /** Zones as % of max heart rate (Bevel default method), computed here. */
    bevel: z.array(ZoneTimeSchema).optional(),
    /** Zones from the custom_zones input. */
    custom: z.array(ZoneTimeSchema).optional(),
  }),
  /** Heart rate per segment of the plan input. */
  plan: z
    .object({
      text: z.string(),
      workLabel: z.string(),
      segments: z.array(
        z.object({
          index: z.number(),
          label: z.string(),
          set: z.number().optional(),
          work: z.boolean(),
          start_local: z.string(),
          end_local: z.string(),
          durationSec: z.number(),
          cutShort: z.boolean().optional(),
          peak: z.number().optional(),
          avg: z.number().optional(),
          min: z.number().optional(),
          end: z.object({ time_local: z.string(), bpm: z.number() }).optional(),
          pointCount: z.number(),
        }),
      ),
      recovery: z
        .object({
          segmentIndex: z.number(),
          atEnd: z.object({ time_local: z.string(), bpm: z.number() }).optional(),
          after60s: z.object({ time_local: z.string(), bpm: z.number() }).optional(),
          hrr60: z.number().optional(),
        })
        .optional(),
      /** Workout time after the planned segments, in seconds. */
      unplannedTailSec: z.number(),
    })
    .optional(),
  events: z.array(ExerciseEventSchema),
  laps: z.array(ExerciseLapSchema),
  points: z.array(HeartRatePointSchema),
});
export type ExerciseHeartRate = z.infer<typeof ExerciseHeartRateSchema>;

export const ExerciseTcxSchema = z.object({
  exerciseId: z.string(),
  logId: z.number(),
  bytes: z.number(),
  trackpointCount: z.number(),
  heartRateTrackpointCount: z.number(),
  hasPosition: z.boolean(),
  truncated: z.boolean(),
  tcx: z.string(),
});
export type ExerciseTcx = z.infer<typeof ExerciseTcxSchema>;

export type ExerciseHrOptions = {
  resolution: HrResolutionT;
  paddingMinutes: number;
  maxHr?: number;
  /** Lower zone bounds from the user (e.g. their app); gives zones.custom. */
  customZones?: Array<{ name?: string; min: number }>;
  /** Workout plan such as `5w 3r [3r 3w]x4 8w`; gives `plan` with per-segment heart rate. */
  plan?: string;
  /** Segments with this label are work segments; HRR60 follows the last one. */
  workLabel?: string;
  /** False leaves `points` empty (useful with `plan`). */
  includePoints?: boolean;
};

/** How a tool names one exercise: Google id, or the numeric logId plus an optional date hint. */
export type ExerciseRef = { exerciseId?: string; logId?: number; date?: string };

// ---------- Sleep ----------
export const SleepStageSchema = z.object({
  dateTime: z.string(),
  level: z.string(),
  seconds: z.number(),
});
export const SleepLogSchema = z.object({
  logId: z.number(),
  dateOfSleep: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  duration: z.number(), // ms
  minutesAsleep: z.number(),
  minutesAwake: z.number().optional(),
  minutesToFallAsleep: z.number().optional(),
  timeInBed: z.number().optional(),
  efficiency: z.number().optional(),
  type: z.string().optional(),
  isMainSleep: z.boolean().optional(),
  infoCode: z.number().optional(),
  levels: z
    .object({
      summary: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      data: z.array(SleepStageSchema).optional(),
      shortData: z.array(SleepStageSchema).optional(),
    })
    .optional(),
});
export type SleepLog = z.infer<typeof SleepLogSchema>;

// ---------- Body ----------
export const WeightLogSchema = z.object({
  logId: z.number().optional(),
  date: z.string(),
  time: z.string().optional(),
  weight: z.number(),
  bmi: z.number().optional(),
  fat: z.number().optional(),
  source: z.string().optional(),
});
export type WeightLog = z.infer<typeof WeightLogSchema>;

export const BodyFatLogSchema = z.object({
  logId: z.number().optional(),
  date: z.string(),
  time: z.string().optional(),
  fat: z.number(),
  source: z.string().optional(),
});
export type BodyFatLog = z.infer<typeof BodyFatLogSchema>;

export const BodyLogSchema = z.object({
  weight: z.array(WeightLogSchema).optional(),
  fat: z.array(BodyFatLogSchema).optional(),
});
export type BodyLog = z.infer<typeof BodyLogSchema>;

// ---------- Food log ----------
export const MealType = z.enum([
  'Breakfast',
  'MorningSnack',
  'Lunch',
  'AfternoonSnack',
  'Dinner',
  'Anytime',
]);
export type MealTypeT = z.infer<typeof MealType>;

export const NutritionalValuesSchema = z.object({
  calories: z.number().optional(),
  carbs: z.number().optional(),
  fat: z.number().optional(),
  fiber: z.number().optional(),
  protein: z.number().optional(),
  sodium: z.number().optional(),
  sugar: z.number().optional(),
});
export type NutritionalValues = z.infer<typeof NutritionalValuesSchema>;

export const FoodLogEntrySchema = z.object({
  logId: z.number(),
  loggedFood: z
    .object({
      name: z.string().optional(),
      mealTypeId: z.number().optional(),
      unit: z.object({ name: z.string().optional(), plural: z.string().optional() }).optional(),
      amount: z.number().optional(),
      calories: z.number().optional(),
      accessLevel: z.string().optional(),
      brand: z.string().optional(),
      foodId: z.number().optional(),
    })
    .optional(),
  nutritionalValues: NutritionalValuesSchema.optional(),
  logDate: z.string().optional(),
});
export type FoodLogEntry = z.infer<typeof FoodLogEntrySchema>;

export const WaterLogEntrySchema = z.object({
  logId: z.number(),
  amount: z.number(),
});
export type WaterLogEntry = z.infer<typeof WaterLogEntrySchema>;

export const FoodLogSchema = z.object({
  foods: z.array(FoodLogEntrySchema).optional(),
  summary: NutritionalValuesSchema.extend({ water: z.number().optional() }).optional(),
  goals: z
    .object({
      calories: z.number().optional(),
      estimatedCaloriesOut: z.number().optional(),
    })
    .optional(),
  water: z
    .object({
      summary: z.object({ water: z.number().optional() }).optional(),
      water: z.array(WaterLogEntrySchema).optional(),
    })
    .optional(),
});
export type FoodLog = z.infer<typeof FoodLogSchema>;

// ---------- SpO2 ----------
export const SpO2DaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    avg: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
});
export type SpO2Day = z.infer<typeof SpO2DaySchema>;

// ---------- Respiratory rate ----------
export const RespiratoryRateDaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    breathingRate: z.number().optional(),
    fullSleepSummary: z.object({ breathingRate: z.number().optional() }).optional(),
    deepSleepSummary: z.object({ breathingRate: z.number().optional() }).optional(),
    remSleepSummary: z.object({ breathingRate: z.number().optional() }).optional(),
    lightSleepSummary: z.object({ breathingRate: z.number().optional() }).optional(),
  }),
});
export type RespiratoryRateDay = z.infer<typeof RespiratoryRateDaySchema>;

// ---------- Skin temperature ----------
export const SkinTempDaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    nightlyRelative: z.number().optional(),
    nightlyCelsius: z.number().optional(),
  }),
  logType: z.string().optional(),
});
export type SkinTempDay = z.infer<typeof SkinTempDaySchema>;

// ---------- HRV ----------
export const HrvDaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    dailyRmssd: z.number().optional(),
    deepRmssd: z.number().optional(),
  }),
});
export type HrvDay = z.infer<typeof HrvDaySchema>;

// ---------- Cardio fitness ----------
export const CardioFitnessSchema = z.object({
  dateTime: z.string(),
  value: z.object({
    vo2Max: z.union([z.string(), z.number()]).optional(),
    // Fitbit returns ranges like "45-49" or numeric values depending on device
  }),
});
export type CardioFitness = z.infer<typeof CardioFitnessSchema>;

// ---------- Write inputs ----------
export type LogFoodInput = {
  date: string;
  mealType: MealTypeT;
  /** Free-text food name (Japanese OK). Written to Fitbit as a private entry. */
  foodName: string;
  /** kcal for the logged portion. */
  calories: number;
  /** Portion count. Default 1. */
  amount?: number;
  brand?: string;
  nutritionalValues?: NutritionalValues;
};

export type MealItemInput = {
  name: string;
  estimatedGrams?: number;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  confidence?: 'high' | 'medium' | 'low';
};

export type LogMealInput = {
  date: string;
  mealType: MealTypeT;
  items: MealItemInput[];
  notes?: string;
};

export type LogWaterInput = {
  date: string;
  amountMl: number;
};

export type LogWeightInput = {
  date: string;
  time?: string;
  weightKg: number;
};

export type LogBodyFatInput = {
  date: string;
  time?: string;
  fatPercent: number;
};

export type LogActivityInput = {
  date: string;
  startTime: string; // HH:mm:ss
  activityId?: number;
  activityName?: string;
  manualCalories?: number;
  durationMs: number;
  distanceKm?: number;
};

export const WORKOUT_TYPES = [
  'WEIGHTLIFTING',
  'STRENGTH_TRAINING',
  'CORE_TRAINING',
  'HIIT',
  'BADMINTON',
  'BOWLING',
  'WALKING',
  'RUNNING',
] as const;

export type LogWorkoutInput = {
  /** Local date the workout starts on. */
  date: string;
  /** Local HH:MM. An end at or before the start rolls over to the next day. */
  start: string;
  end: string;
  exerciseType: (typeof WORKOUT_TYPES)[number];
  name: string;
  notes?: string;
};

export type LogSleepInput = {
  date: string;
  startTime: string; // HH:mm
  durationMs: number;
};

// ---------- Provider interface ----------
export interface HealthProvider {
  // --- Read ---
  getProfile(): Promise<Profile>;
  listDevices(): Promise<Device[]>;
  getDailySummary(date: string): Promise<DailySummary>;
  getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries>;
  getExerciseList(opts: ExerciseListOptions): Promise<ExerciseLog[]>;
  getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]>;
  getHeartRateIntraday(
    date: string,
    detailLevel: IntradayDetailLevelT,
    window?: IntradayWindow,
  ): Promise<HeartRateIntraday>;
  getSleep(date: string): Promise<SleepLog[]>;
  getSleepRange(start: string, end: string): Promise<SleepLog[]>;
  getBodyLog(start: string, end: string): Promise<BodyLog>;
  getFoodLog(date: string): Promise<FoodLog>;
  getSpO2(start: string, end: string): Promise<SpO2Day[]>;
  getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]>;
  getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]>;
  getHRV(start: string, end: string): Promise<HrvDay[]>;
  getCardioFitness(date: string): Promise<CardioFitness>;
  /** Optional: only the Google Health provider implements these. */
  getHeartRateSeries?(
    start: string,
    end: string,
    resolution: HrResolutionT,
  ): Promise<HeartRateSeries>;
  getExerciseHeartRate?(ref: ExerciseRef, opts: ExerciseHrOptions): Promise<ExerciseHeartRate>;
  logWorkout?(input: LogWorkoutInput): Promise<ExerciseLog>;
  deleteWorkout?(exerciseId: string): Promise<void>;
  exportExerciseTcx?(
    ref: ExerciseRef,
    opts: { partialData: boolean },
  ): Promise<{ exerciseId: string; logId: number; tcx: string }>;

  // --- Write ---
  logFood(input: LogFoodInput): Promise<FoodLogEntry>;
  logMeal(input: LogMealInput): Promise<FoodLogEntry[]>;
  logWater(input: LogWaterInput): Promise<WaterLogEntry>;
  logWeight(input: LogWeightInput): Promise<WeightLog>;
  logBodyFat(input: LogBodyFatInput): Promise<BodyFatLog>;
  logActivity(input: LogActivityInput): Promise<ExerciseLog>;
  logSleep(input: LogSleepInput): Promise<SleepLog>;
  deleteFoodLog(logId: number): Promise<void>;
  deleteWaterLog(logId: number): Promise<void>;
  deleteWeightLog(logId: number): Promise<void>;
  deleteBodyFatLog(logId: number): Promise<void>;
  deleteActivityLog(logId: number): Promise<void>;
  deleteSleepLog(logId: number): Promise<void>;
}
