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
  min: z.number(),
  max: z.number(),
  minutes: z.number().optional(),
  caloriesOut: z.number().optional(),
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
  activityName: z.string().optional(),
  activityTypeId: z.number().optional(),
  startTime: z.string().optional(),
  duration: z.number().optional(),
  calories: z.number().optional(),
  steps: z.number().optional(),
  distance: z.number().optional(),
  distanceUnit: z.string().optional(),
  averageHeartRate: z.number().optional(),
  heartRateZones: z.array(HeartRateZoneSchema).optional(),
});
export type ExerciseLog = z.infer<typeof ExerciseLogSchema>;

// ---------- Heart rate range ----------
export const HeartRateDaySchema = z.object({
  dateTime: z.string(),
  value: z.object({
    restingHeartRate: z.number().optional(),
    heartRateZones: z.array(HeartRateZoneSchema).optional(),
    customHeartRateZones: z.array(HeartRateZoneSchema).optional(),
  }),
});
export type HeartRateDay = z.infer<typeof HeartRateDaySchema>;

// ---------- Heart rate intraday ----------
export const IntradayDetailLevel = z.enum(['1sec', '1min', '5min', '15min']);
export type IntradayDetailLevelT = z.infer<typeof IntradayDetailLevel>;

export const HeartRateIntradayPointSchema = z.object({
  time: z.string(),
  value: z.number(),
});
export const HeartRateIntradaySchema = z.object({
  date: z.string(),
  detailLevel: IntradayDetailLevel,
  restingHeartRate: z.number().optional(),
  heartRateZones: z.array(HeartRateZoneSchema).optional(),
  points: z.array(HeartRateIntradayPointSchema),
});
export type HeartRateIntraday = z.infer<typeof HeartRateIntradaySchema>;

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

// ---------- Write inputs (used by M7) ----------
export type LogFoodInput = {
  date: string;
  foodName: string;
  calories: number;
  mealType: MealTypeT;
  amount?: number;
  unitName?: string;
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
  getExerciseList(opts: { beforeDate?: string; limit?: number }): Promise<ExerciseLog[]>;
  getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]>;
  getHeartRateIntraday(date: string, detailLevel: IntradayDetailLevelT): Promise<HeartRateIntraday>;
  getSleep(date: string): Promise<SleepLog[]>;
  getSleepRange(start: string, end: string): Promise<SleepLog[]>;
  getBodyLog(start: string, end: string): Promise<BodyLog>;
  getFoodLog(date: string): Promise<FoodLog>;
  getSpO2(start: string, end: string): Promise<SpO2Day[]>;
  getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]>;
  getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]>;
  getHRV(start: string, end: string): Promise<HrvDay[]>;
  getCardioFitness(date: string): Promise<CardioFitness>;

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
