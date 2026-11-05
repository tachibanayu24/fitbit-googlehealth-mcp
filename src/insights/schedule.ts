export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Schedule = {
  wake: Record<Weekday, string>;
  overrides: Record<string, string>;
};

export type NightPlan = {
  wakeDate: string;
  wake: string;
  early: boolean;
  goalMin: number;
  bedtime: string;
  windDown: string;
  fromOverride: boolean;
};

/** Neutral default alarm: 07:00 every day. Override per deployment with SLEEP_WAKE_TIME. */
export const DEFAULT_WAKE = '07:00';

export const DEFAULT_SCHEDULE: Schedule = {
  wake: Object.fromEntries(WEEKDAYS.map((d) => [d, DEFAULT_WAKE])) as Record<Weekday, string>,
  overrides: {},
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EARLY_BEFORE_MIN = 5 * 60 + 30;
export const GOAL_MIN = 450;
const EARLY_GOAL_MIN = 420;
// Falling asleep plus the brief wake-ups a normal night has, so time in bed covers the goal.
const SETTLE_MIN = 30;
const WIND_DOWN_MIN = 60;

export const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toClock = (minute: number) => {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function assertClock(value: string, field = 'time'): void {
  if (!HHMM.test(value)) throw new Error(`${field} must be HH:MM in 24 hour time, got "${value}"`);
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] as Weekday;
}

/** The night that ends on wakeDate: alarm time, sleep goal, and when to wind down and be in bed. */
export function planNight(schedule: Schedule, wakeDate: string): NightPlan {
  const override = schedule.overrides[wakeDate];
  const wake = override ?? schedule.wake[weekdayOf(wakeDate)];
  const wakeMin = toMinute(wake) ?? 0;
  const early = wakeMin < EARLY_BEFORE_MIN;
  const goalMin = early ? EARLY_GOAL_MIN : GOAL_MIN;
  const bed = wakeMin - goalMin - SETTLE_MIN;
  return {
    wakeDate,
    wake,
    early,
    goalMin,
    bedtime: toClock(bed),
    windDown: toClock(bed - WIND_DOWN_MIN),
    fromOverride: override !== undefined,
  };
}

/** The effective schedule: the neutral default, with SLEEP_WAKE_TIME applied when set. */
export function scheduleOf(env?: { SLEEP_WAKE_TIME?: string }): Schedule {
  const wake = env?.SLEEP_WAKE_TIME?.trim();
  if (!wake) return DEFAULT_SCHEDULE;
  assertClock(wake, 'SLEEP_WAKE_TIME');
  return {
    ...DEFAULT_SCHEDULE,
    wake: Object.fromEntries(WEEKDAYS.map((d) => [d, wake])) as Record<Weekday, string>,
  };
}
