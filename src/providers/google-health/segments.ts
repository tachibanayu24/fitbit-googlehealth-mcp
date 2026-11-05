/**
 * Workout plans such as `5w 3r [3r 3w]x4 8w 5w`, and heart rate per plan
 * segment. Pure functions; the provider supplies samples and pauses.
 */
import { type HrSample, isoLocal } from './hr-series';

/** One planned segment. `set` is the repeat number inside the innermost group. */
export type PlanStep = { label: string; durationSec: number; set?: number };

const MAX_STEPS = 200;
const MAX_REPEAT = 50;

/**
 * Parse a plan. A step is a duration plus a label: `5w` = 5 minutes of `w`,
 * `1.5r` = 90 seconds of `r`, `1:30r` = 1 minute 30 seconds of `r`.
 * `[ ... ]xN` repeats a group N times; groups can nest.
 */
export function parsePlan(plan: string): PlanStep[] {
  const tokens = plan.match(/\[|\]\s*[x×]\s*\d+|\d+:\d{2}\p{L}+|\d+(?:\.\d+)?\p{L}+|\S/gu) ?? [];
  let pos = 0;

  const fail = (msg: string): never => {
    throw new RangeError(
      `plan: ${msg}. Example: "5w 3r [3r 3w]x4 8w" (minutes + label, [..]xN repeats).`,
    );
  };

  const parseList = (depth: number): PlanStep[] => {
    const out: PlanStep[] = [];
    while (pos < tokens.length) {
      const t = tokens[pos] as string;
      if (t === '[') {
        pos++;
        const inner = parseList(depth + 1);
        const close = tokens[pos];
        if (!close?.startsWith(']')) fail('a "[" group has no "]xN"');
        pos++;
        const n = Number((close as string).replace(/\D/g, ''));
        if (n < 1 || n > MAX_REPEAT) fail(`repeat count must be 1 to ${MAX_REPEAT}`);
        for (let set = 1; set <= n; set++) {
          for (const s of inner) out.push(s.set === undefined ? { ...s, set } : s);
        }
      } else if (t.startsWith(']')) {
        if (depth === 0) fail('"]" without "["');
        return out;
      } else {
        const m = /^(?:(\d+):(\d{2})|(\d+(?:\.\d+)?))(\p{L}+)$/u.exec(t);
        if (!m) fail(`cannot read "${t}"`);
        const [, mm, ss, minutes, label] = m as RegExpExecArray;
        if (Number(ss) >= 60) fail(`"${t}" has more than 59 seconds`);
        const sec = minutes !== undefined ? Number(minutes) * 60 : Number(mm) * 60 + Number(ss);
        if (!(sec > 0)) fail(`"${t}" has no duration`);
        out.push({ label: label as string, durationSec: Math.round(sec) });
        pos++;
      }
      if (out.length > MAX_STEPS) fail(`more than ${MAX_STEPS} segments`);
    }
    if (depth > 0) fail('a "[" group has no "]xN"');
    return out;
  };

  const steps = parseList(0);
  if (steps.length === 0) fail('no segments');
  return steps;
}

/**
 * Pause intervals `[pausedAt, resumedAt]` from workout events. A pause with
 * no resume (the one right before STOP) is left out: nothing follows it.
 */
export function pausesFromEvents(
  events: Array<{ type: string; t: number }>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pausedAt: number | undefined;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const type = e.type.toUpperCase();
    if (type.includes('PAUSE') && pausedAt === undefined) pausedAt = e.t;
    else if (type.includes('RESUME') && pausedAt !== undefined) {
      out.push([pausedAt, e.t]);
      pausedAt = undefined;
    }
  }
  return out;
}

/** Wall-clock instant of `activeMs` of active time after `startMs`, skipping pauses. */
export function activeToWall(
  startMs: number,
  activeMs: number,
  pauses: Array<[number, number]>,
): number {
  let wall = startMs + activeMs;
  for (const [a, b] of pauses) {
    // Only the part of a pause after the start takes active time away.
    // A segment edge exactly at the pause start stays before the pause.
    if (b > startMs && a < wall) wall += b - Math.max(a, startMs);
  }
  return wall;
}

type Point = { time_local: string; bpm: number };

export type SegmentStats = {
  index: number;
  label: string;
  set?: number;
  work: boolean;
  start_local: string;
  end_local: string;
  durationSec: number;
  /** True when the workout ended before the planned end of this segment. */
  cutShort?: boolean;
  peak?: number;
  avg?: number;
  min?: number;
  /** The last sample of the segment. */
  end?: Point;
  pointCount: number;
};

export type Recovery = {
  segmentIndex: number;
  /** The last sample of the last work segment (within 10 s of its end). */
  atEnd?: Point;
  /** The sample nearest to 60 s after that end (within 10 s). */
  after60s?: Point;
  /** atEnd.bpm - after60s.bpm. */
  hrr60?: number;
};

/**
 * Heart rate per plan segment, and HRR60 after the last work segment.
 * Segments follow each other from `startMs` in active time (pauses skipped)
 * and stop at `endMs`. `samples` must be sorted and may run past `endMs`.
 */
export function analyzeSegments(
  samples: HrSample[],
  steps: PlanStep[],
  opts: {
    startMs: number;
    endMs: number;
    offMs: number;
    pauses: Array<[number, number]>;
    workLabel: string;
  },
): { segments: SegmentStats[]; recovery?: Recovery; unplannedTailSec: number } {
  const at = (t: number, bpm: number): Point => ({ time_local: isoLocal(t, opts.offMs), bpm });
  const pauseAt = (t: number) => opts.pauses.find(([pa, pb]) => pa <= t && t < pb);
  const workLabel = opts.workLabel.toLowerCase();
  const segments: SegmentStats[] = [];
  let activeMs = 0;
  let lastWork: { index: number; endMs: number } | undefined;
  let i = 0;

  for (const [n, step] of steps.entries()) {
    // A segment that starts at a pause starts when the pause ends.
    const edge = activeToWall(opts.startMs, activeMs, opts.pauses);
    const a = pauseAt(edge)?.[1] ?? edge;
    activeMs += step.durationSec * 1000;
    const planned = activeToWall(opts.startMs, activeMs, opts.pauses);
    if (a >= opts.endMs) break;
    const b = Math.min(planned, opts.endMs);

    while (i < samples.length && (samples[i] as HrSample).t < a) i++;
    let sum = 0;
    let count = 0;
    let peak = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    let last: HrSample | undefined;
    for (let k = i; k < samples.length && (samples[k] as HrSample).t < b; k++) {
      const s = samples[k] as HrSample;
      // The watch still records during a pause; those samples are not part of the plan.
      if (pauseAt(s.t)) continue;
      sum += s.bpm;
      count++;
      if (s.bpm > peak) peak = s.bpm;
      if (s.bpm < min) min = s.bpm;
      last = s;
    }

    const work = step.label.toLowerCase() === workLabel;
    if (work) lastWork = { index: n + 1, endMs: b };
    segments.push({
      index: n + 1,
      label: step.label,
      set: step.set,
      work,
      start_local: isoLocal(a, opts.offMs),
      end_local: isoLocal(b, opts.offMs),
      durationSec: step.durationSec,
      cutShort: planned > opts.endMs ? true : undefined,
      peak: count ? peak : undefined,
      avg: count ? Math.round((sum / count) * 10) / 10 : undefined,
      min: count ? min : undefined,
      end: last && at(last.t, last.bpm),
      pointCount: count,
    });
  }

  const planEnd = activeToWall(opts.startMs, activeMs, opts.pauses);
  const unplannedTailSec = Math.max(0, Math.round((opts.endMs - planEnd) / 1000));
  return {
    segments,
    recovery: lastWork && recoveryAfter(samples, lastWork, at),
    unplannedTailSec,
  };
}

function recoveryAfter(
  samples: HrSample[],
  work: { index: number; endMs: number },
  at: (t: number, bpm: number) => Point,
): Recovery {
  let end: HrSample | undefined;
  let after: HrSample | undefined;
  const target = work.endMs + 60_000;
  for (const s of samples) {
    if (s.t < work.endMs && s.t >= work.endMs - 10_000) end = s;
    if (
      Math.abs(s.t - target) <= 10_000 &&
      (!after || Math.abs(s.t - target) < Math.abs(after.t - target))
    ) {
      after = s;
    }
  }
  return {
    segmentIndex: work.index,
    atEnd: end && at(end.t, end.bpm),
    after60s: after && at(after.t, after.bpm),
    hrr60: end && after ? end.bpm - after.bpm : undefined,
  };
}
