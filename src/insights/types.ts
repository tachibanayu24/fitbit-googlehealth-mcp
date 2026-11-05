export type SleepNight = {
  bedtime: string;
  wake: string;
  startMs: number;
  endMs: number;
  bedMinute: number;
  wakeMinute: number;
  asleep: number;
  inBed: number;
  awake: number;
  wakeUps: number;
  deep?: number;
  rem?: number;
  light?: number;
  latency?: number;
  naps: number;
  napMin: number;
  joined?: number;
};

export type Zones = { light: number; moderate: number; vigorous: number; peak: number };

export type Exercise = {
  date: string;
  name: string;
  type: string;
  start: string;
  startMs: number;
  endMs: number;
  minutes: number;
  avgHr?: number;
  azm?: number;
  calories?: number;
  steps?: number;
  zones?: Zones;
};

export type Day = {
  date: string;
  rhr?: number;
  rhrWithSleep?: boolean;
  hrv?: number;
  hrvDeep?: number;
  sleepHr?: number;
  breathing?: number;
  spo2?: number;
  spo2Low?: number;
  skinTemp?: number;
  skinTempDelta?: number;
  vo2?: number;
  sleep?: SleepNight;
  steps?: number;
  azm?: number;
  zones?: Zones;
  activeMinutes?: { light: number; moderate: number; vigorous: number };
  calories?: number;
  exercises: Exercise[];
};

export type Point = { t: string; v: number; offset?: number };

export type NightDetail = {
  stages: Array<{ stage: string; start: string; offset: number; minutes: number }>;
  heartRate: Array<{ t: string; offset: number; avg: number; min: number; max: number }>;
  spo2: {
    avg?: number;
    min?: number;
    minutesBelow90: number;
    coverage: number;
    samples: Point[];
  };
  breathingByStage: { light?: number; deep?: number; rem?: number; full?: number };
};

export type DayDetail = {
  stepsByHour: Point[];
  distanceKm?: number;
  sedentary: { minutes: number; longest: number; stretches: number };
};

/** Five-minute average heart rate for one local day, null where nothing was recorded. */
export type HeartBuckets = Array<number | null>;
