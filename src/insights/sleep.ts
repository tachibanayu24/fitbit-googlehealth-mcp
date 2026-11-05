import type { SleepNight } from './types';

type Row = Record<string, unknown>;

export type Segment = { stage: string; startMs: number; endMs: number };

const ms = (v: unknown) => Date.parse(String(v));

export function segments(list: unknown): Segment[] {
  return ((list as Row[] | undefined) ?? [])
    .map((x) => ({
      stage: String(x.type ?? '').toLowerCase(),
      startMs: ms(x.startTime),
      endMs: ms(x.endTime),
    }))
    .filter((x) => Number.isFinite(x.startMs) && x.endMs > x.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

const BRIEF_WAKE_MS = 5 * 60_000;

/** Wake-ups under 5 minutes inside the night, which Google's app counts as sleep. */
export function briefWakeMinutes(stages: unknown): number {
  const inner = segments(stages).slice(1, -1);
  const total = inner
    .filter((s) => s.stage === 'awake' && s.endMs - s.startMs < BRIEF_WAKE_MS)
    .reduce((a, s) => a + s.endMs - s.startMs, 0);
  return Math.round(total / 60_000);
}

export function stageTotals(summary: Row) {
  const stage = (type: string) =>
    ((summary.stagesSummary as Row[] | undefined) ?? []).find((x) => x.type === type);
  const minutes = (type: string) => {
    const hit = stage(type);
    return hit ? Number(hit.minutes) : undefined;
  };
  return {
    asleep: Number(summary.minutesAsleep ?? 0),
    awake: Number(summary.minutesAwake ?? 0),
    deep: minutes('DEEP'),
    rem: minutes('REM'),
    light: minutes('LIGHT'),
    wakeUps: Number(stage('AWAKE')?.count ?? 0),
  };
}

// Own choice: a second sleep this close to the main one is the same night, not a nap.
const BACK_TO_SLEEP_MIN = 90;
// Own choice: back in bed before noon after being up a while still finishes the night.
const LATER_SLEEP_MIN = 180;
const NOON_MINUTE = 720;
// Own choice: asleep from 6pm and up again before midnight is the start of the coming night.
const EVENING_MINUTE = 1080;
const MIN_NIGHT_MIN = 180;

export type SleepRecord = { date: string; main: boolean; night: SleepNight };

export const totalAsleep = (n: SleepNight) => n.asleep + n.napMin;

const plus = (a?: number, b?: number) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

function gapMin(a: SleepNight, b: SleepNight): number | undefined {
  if (b.startMs >= a.endMs) return (b.startMs - a.endMs) / 60_000;
  if (b.endMs <= a.startMs) return (a.startMs - b.endMs) / 60_000;
  return undefined;
}

const laterSleep = (night: SleepNight, n: SleepNight) =>
  n.startMs >= night.endMs &&
  (gapMin(night, n) ?? Infinity) <= LATER_SLEEP_MIN &&
  n.bedMinute < NOON_MINUTE;

const eveningSleep = (n: SleepNight) => n.bedMinute >= EVENING_MINUTE && n.wakeMinute > n.bedMinute;

const earlierSleep = (night: SleepNight, n: SleepNight) =>
  n.endMs <= night.startMs && (gapMin(night, n) ?? Infinity) <= LATER_SLEEP_MIN && eveningSleep(n);

/** Evening sleeps that lead into a night move to that night's wake date, latest first. */
function attributed(records: SleepRecord[]): SleepRecord[] {
  const out = records.map((r) => ({ ...r }));
  for (const r of [...out].sort((a, b) => b.night.startMs - a.night.startMs)) {
    if (!eveningSleep(r.night)) continue;
    const next = out
      .filter((x) => x.night.startMs >= r.night.endMs)
      .filter((x) => (x.night.startMs - r.night.endMs) / 60_000 <= LATER_SLEEP_MIN)
      .sort((a, b) => a.night.startMs - b.night.startMs)[0];
    if (next) r.date = next.date;
  }
  return out;
}

/** Two sleeps as one night; the time between counts as awake in bed unless he was up. */
export function joinNights(a: SleepNight, b: SleepNight, gapInBed = true): SleepNight {
  const [first, last] = a.startMs <= b.startMs ? [a, b] : [b, a];
  const between = Math.max(0, Math.round((last.startMs - first.endMs) / 60_000));
  const gap = gapInBed ? between : 0;
  return {
    ...a,
    bedtime: first.bedtime,
    bedMinute: first.bedMinute,
    startMs: first.startMs,
    latency: first.latency,
    wake: last.wake,
    wakeMinute: last.wakeMinute,
    endMs: last.endMs,
    asleep: a.asleep + b.asleep,
    inBed: a.inBed + b.inBed + gap,
    awake: a.awake + b.awake + gap,
    wakeUps: a.wakeUps + b.wakeUps + 1,
    deep: plus(a.deep, b.deep),
    rem: plus(a.rem, b.rem),
    light: plus(a.light, b.light),
    joined: (a.joined ?? 0) + (b.joined ?? 0) + 1,
  };
}

/** One night per wake date: near sleeps join it, far ones are naps, overlapping copies drop. */
export function nightsByDate(records: SleepRecord[]): Map<string, SleepNight> {
  const byDate = new Map<string, SleepRecord[]>();
  for (const r of attributed(records)) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const out = new Map<string, SleepNight>();
  for (const [date, list] of byDate) {
    const ranked = [...list].sort(
      (a, b) => Number(b.main) - Number(a.main) || b.night.asleep - a.night.asleep,
    );
    const first = ranked[0];
    if (!first || (!first.main && first.night.asleep < MIN_NIGHT_MIN)) continue;
    let night: SleepNight = { ...first.night };
    let rest = ranked.slice(1).map((r) => r.night);
    for (let near = true; near; ) {
      const hit = rest.find((n) => (gapMin(night, n) ?? Infinity) <= BACK_TO_SLEEP_MIN);
      const later = hit
        ? undefined
        : rest.find((n) => laterSleep(night, n) || earlierSleep(night, n));
      const next = hit ?? later;
      near = next !== undefined;
      if (next) {
        night = joinNights(night, next, next === hit);
        rest = rest.filter((n) => n !== next);
      }
    }
    for (const nap of rest.filter((n) => gapMin(night, n) !== undefined)) {
      night.naps += 1;
      night.napMin += nap.asleep;
    }
    out.set(date, night);
  }
  return out;
}
