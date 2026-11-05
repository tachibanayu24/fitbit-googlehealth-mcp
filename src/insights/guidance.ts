import { type NightPlan, toMinute } from './schedule';
import type { Score } from './scores';
import { totalAsleep } from './sleep';
import type { Day } from './types';

export const CALIBRATION_NIGHTS = 14;
const SHORT_NIGHT_MIN = 360;
// Own choice: five hours behind over the week outweighs a good morning reading.
const HIGH_DEBT_MIN = 300;

export type Guidance = {
  headline: string;
  training: string;
  actions: string[];
};

const hm = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;

export function ampm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = Number(h);
  return `${((hour + 11) % 12) + 1}:${String(m).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
}

export function calibration(days: Day[]) {
  const nights = days.filter((d) => d.hrv !== undefined).length;
  return {
    nights,
    needed: CALIBRATION_NIGHTS,
    done: nights >= CALIBRATION_NIGHTS,
    readinessFrom: 4,
    personalBaselines: nights >= 4,
  };
}

/** One line on sleep timing for right now: before the alarm, before wind-down, or past bedtime. */
export function sleepTiming(
  now: number,
  lastNight: NightPlan,
  tonight: NightPlan,
  upAlready = false,
): string {
  const wokeAt = toMinute(lastNight.wake);
  if (now < wokeAt && !upAlready) {
    return `Past your bedtime. Sleep now, your ${ampm(lastNight.wake)} alarm is ${hm(wokeAt - now)} away.`;
  }
  const evening = (hhmm: string) => toMinute(hhmm) + (toMinute(hhmm) < wokeAt ? 1440 : 0);
  const bed = evening(tonight.bedtime);
  const alarm = `${ampm(tonight.wake)} ${tonight.early ? 'shift alarm' : 'alarm'}`;
  if (now >= bed) {
    return `Past your bedtime. Get to bed now, your ${alarm} is ${hm(toMinute(tonight.wake) + 1440 - now)} away.`;
  }
  if (now >= evening(tonight.windDown)) {
    return `Wind down now: screens away, lights low. In bed by ${ampm(tonight.bedtime)} for your ${alarm}.`;
  }
  return `Tonight: wind down from ${ampm(tonight.windDown)}, in bed by ${ampm(tonight.bedtime)} for your ${alarm}.`;
}

export function guidance(input: {
  readiness?: Score;
  day: Day;
  isToday: boolean;
  now: number;
  lastNight: NightPlan;
  tonight: NightPlan;
  flags: string[];
  debtMin?: number;
}): Guidance {
  const { readiness, day, isToday, flags, now, lastNight, tonight } = input;
  const band = readiness?.band;
  const asleep = day.sleep && totalAsleep(day.sleep);
  const short = asleep !== undefined && asleep < SHORT_NIGHT_MIN;
  const behind = band === 'green' && (input.debtMin ?? 0) >= HIGH_DEBT_MIN;
  const training = behind
    ? `Train as planned, but hold your weights: you are ${hm(input.debtMin ?? 0)} behind on sleep this week.`
    : band === 'green'
      ? 'Push for progress today: add a rep or the smallest weight jump.'
      : band === 'yellow'
        ? 'Train as planned, but hold your weights and skip the finisher.'
        : band === 'red'
          ? 'Recovery day. A light 25 minute session or rest, your call.'
          : short
            ? 'Train by feel today: keep the weights you know and skip the finisher.'
            : 'Train as planned and log what you lift, so the app learns your starting point.';

  const timing = isToday ? sleepTiming(now, lastNight, tonight, !!day.sleep) : undefined;
  const evening = isToday && !timing?.startsWith('Tonight');
  const debt =
    asleep !== undefined && asleep < lastNight.goalMin
      ? `You slept ${hm(asleep)}, ${hm(lastNight.goalMin - asleep)} under your ${hm(lastNight.goalMin)} goal.`
      : undefined;
  const steps =
    isToday && !evening && day.steps !== undefined && day.steps < 8000
      ? `${(8000 - day.steps).toLocaleString('en-AU')} more steps gets you to 8,000 today.`
      : undefined;
  const ordered = evening ? [timing, ...flags, debt] : [debt, timing, ...flags, steps];
  const actions = ordered.filter((a): a is string => !!a);

  const headline = behind
    ? 'Recovered, but short on sleep.'
    : band === 'green'
      ? 'Recovered and ready.'
      : band === 'yellow'
        ? 'Steady, not fully topped up.'
        : band === 'red'
          ? 'Your body is asking for recovery.'
          : short
            ? 'Short night. Still learning your normal.'
            : 'Still learning your normal.';
  return { headline, training, actions: actions.slice(0, 3) };
}
