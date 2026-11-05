/**
 * Pure helpers for heart-rate time series: parse raw samples, aggregate them
 * into buckets, and compute summary statistics and time in zones.
 *
 * Everything here is CPU-sensitive. A full day of raw samples is 20 000 to
 * 30 000 points, and a free-plan Worker has about 10 ms of CPU per request.
 * So the hot paths avoid `Intl` and per-point allocations where they can.
 */

/** One raw heart-rate sample. */
export type HrSample = {
  /** Instant of the sample, epoch milliseconds. */
  t: number;
  bpm: number;
  /** UTC offset of the wall clock at that instant, in milliseconds. */
  off: number;
};

/** One output point. Bucketed points also carry min, max and sample count. */
export type HrPoint = {
  time_utc: string;
  time_local: string;
  bpm: number;
  min?: number;
  max?: number;
  samples?: number;
};

export type HrSummary = {
  avg?: number;
  min?: number;
  max?: number;
  pointCount: number;
  medianIntervalSec?: number;
  /** Longest time between neighbouring samples, in seconds. */
  maxGapSec?: number;
};

/** A zone in bpm. `max` is inclusive; the top zone ends at max heart rate. */
export type HrZone = { name: string; min: number; max: number };
export type HrZoneTime = HrZone & { seconds: number; minutes: number; percent: number };

/** Output resolution names mapped to bucket width in seconds. 0 = raw. */
export const RESOLUTION_SEC = { raw: 0, '5s': 5, '15s': 15, '1min': 60 } as const;
export type HrResolution = keyof typeof RESOLUTION_SEC;

/** The field mask for heart-rate listings. It cuts the payload about 6 times. */
export const HR_FIELDS =
  'dataPoints(heartRate(beatsPerMinute,sampleTime(physicalTime,utcOffset))),nextPageToken';

/**
 * A gap longer than this is not counted in full when time in zone is summed.
 * The watch sometimes loses contact; a 10-minute hole must not count as
 * 10 minutes at the last known pulse.
 */
const MAX_GAP_MS = 30_000;

const offsetCache = new Map<string, number>();

/** Parse a `"18000s"` offset string, with a small cache for the hot path. */
function parseOffset(v: unknown, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  let ms = offsetCache.get(v);
  if (ms === undefined) {
    const n = Number(v.endsWith('s') ? v.slice(0, -1) : v);
    ms = Number.isFinite(n) ? Math.round(n * 1000) : fallback;
    offsetCache.set(v, ms);
  }
  return ms;
}

type RawRow = {
  heartRate?: {
    beatsPerMinute?: string | number;
    sampleTime?: { physicalTime?: string; utcOffset?: string };
  };
};

/**
 * Convert raw `heart-rate` data points to samples.
 *
 * The API lists newest first. The result is sorted oldest first, and the sort
 * runs only when the input is not already in reverse order.
 */
export function parseHrRows(rows: unknown[], fallbackOffsetMs: number): HrSample[] {
  const out: HrSample[] = [];
  for (const row of rows as RawRow[]) {
    const hr = row.heartRate;
    const ts = hr?.sampleTime?.physicalTime;
    if (!ts) continue;
    const t = Date.parse(ts);
    const bpm = Number(hr.beatsPerMinute);
    if (!Number.isFinite(t) || !Number.isFinite(bpm)) continue;
    out.push({ t, bpm, off: parseOffset(hr.sampleTime?.utcOffset, fallbackOffsetMs) });
  }
  return sortAscending(out);
}

/** Sort samples oldest first. Cheap when the input is fully reversed. */
export function sortAscending(samples: HrSample[]): HrSample[] {
  let desc = true;
  let asc = true;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as HrSample;
    const b = samples[i] as HrSample;
    if (b.t > a.t) desc = false;
    if (b.t < a.t) asc = false;
  }
  if (asc) return samples;
  if (desc) return samples.reverse();
  return samples.sort((a, b) => a.t - b.t);
}

/** `+05:00` style suffix for an offset in milliseconds. */
export function offsetSuffix(offMs: number): string {
  const sign = offMs < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(offMs / 60_000));
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** `2026-09-26T06:15:20Z` — whole seconds, UTC. */
export function isoUtc(t: number): string {
  return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

/** `2026-09-26T11:15:20+05:00` — whole seconds, wall clock plus its offset. */
export function isoLocal(t: number, offMs: number): string {
  return new Date(t + offMs).toISOString().slice(0, 19) + offsetSuffix(offMs);
}

/**
 * Turn samples into output points.
 *
 * `bucketSec = 0` returns every sample. Otherwise samples are grouped into
 * fixed buckets aligned to the epoch (so a 1-minute bucket starts at :00),
 * and each bucket reports the rounded average, min, max and sample count.
 */
export function bucketize(samples: HrSample[], bucketSec: number): HrPoint[] {
  if (bucketSec <= 0) {
    return samples.map((s) => ({
      time_utc: isoUtc(s.t),
      time_local: isoLocal(s.t, s.off),
      bpm: s.bpm,
    }));
  }

  const width = bucketSec * 1000;
  const out: HrPoint[] = [];
  let key = Number.NaN;
  let sum = 0;
  let n = 0;
  let min = 0;
  let max = 0;
  let off = 0;

  const flush = () => {
    if (n === 0) return;
    out.push({
      time_utc: isoUtc(key),
      time_local: isoLocal(key, off),
      bpm: Math.round(sum / n),
      min,
      max,
      samples: n,
    });
  };

  for (const s of samples) {
    const k = Math.floor(s.t / width) * width;
    if (k !== key) {
      flush();
      key = k;
      sum = 0;
      n = 0;
      min = s.bpm;
      max = s.bpm;
      off = s.off;
    }
    sum += s.bpm;
    n++;
    if (s.bpm < min) min = s.bpm;
    if (s.bpm > max) max = s.bpm;
  }
  flush();
  return out;
}

/** Average, min, max, count and median spacing of a sample list. */
export function summarize(samples: HrSample[]): HrSummary {
  if (samples.length === 0) return { pointCount: 0 };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    sum += s.bpm;
    if (s.bpm < min) min = s.bpm;
    if (s.bpm > max) max = s.bpm;
  }
  return {
    avg: Math.round((sum / samples.length) * 10) / 10,
    min,
    max,
    pointCount: samples.length,
    medianIntervalSec: medianIntervalSec(samples),
    maxGapSec: maxGapSec(samples),
  };
}

/** Longest time between neighbouring samples, in seconds. */
export function maxGapSec(samples: HrSample[]): number | undefined {
  if (samples.length < 2) return undefined;
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    const gap = (samples[i] as HrSample).t - (samples[i - 1] as HrSample).t;
    if (gap > max) max = gap;
  }
  return Math.round(max / 100) / 10;
}

/** Median time between neighbouring samples, in seconds. */
export function medianIntervalSec(samples: HrSample[]): number | undefined {
  if (samples.length < 2) return undefined;
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    gaps.push(((samples[i] as HrSample).t - (samples[i - 1] as HrSample).t) / 1000);
  }
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const m =
    gaps.length % 2
      ? (gaps[mid] as number)
      : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
  return Math.round(m * 10) / 10;
}

/** Samples with `from <= t < to`. Input must be sorted oldest first. */
export function sliceByTime(samples: HrSample[], from: number, to: number): HrSample[] {
  return samples.filter((s) => s.t >= from && s.t < to);
}

/**
 * Zones as percent of maximum heart rate, the default method in the Bevel app:
 * restorative < 50 %, then zones 1–5 at 50/60/70/80/90 %. Zone 5 ends at max
 * heart rate, like Peak in the Karvonen zones.
 */
export function percentMaxZones(maxHr: number): HrZone[] {
  // Bevel rounds a bound up: max 188 gives Zone 4 from 151 (80 % = 150.4).
  // The small epsilon keeps exact products (200 * 0.6 = 120) from moving up.
  const at = (p: number) => Math.ceil(maxHr * p - 1e-9);
  return [
    { name: 'Restorative', min: 0, max: at(0.5) - 1 },
    { name: 'Zone 1', min: at(0.5), max: at(0.6) - 1 },
    { name: 'Zone 2', min: at(0.6), max: at(0.7) - 1 },
    { name: 'Zone 3', min: at(0.7), max: at(0.8) - 1 },
    { name: 'Zone 4', min: at(0.8), max: at(0.9) - 1 },
    { name: 'Zone 5', min: at(0.9), max: maxHr },
  ];
}

/**
 * Fitbit heart-rate zones by the Karvonen method (percent of heart-rate
 * reserve, where reserve = max - resting): Fat Burn from 40 %, Cardio from
 * 60 %, Peak from 85 %. Out of Range is everything below Fat Burn.
 *
 * Out of Range starts at 30 bpm, like in the old Fitbit Web API, and Peak
 * ends at max heart rate. A sample above max heart rate still counts as Peak.
 */
export function karvonenZones(maxHr: number, restingHr: number): HrZone[] {
  const at = (p: number) => Math.round(restingHr + (maxHr - restingHr) * p);
  return [
    { name: 'Out of Range', min: 30, max: at(0.4) - 1 },
    { name: 'Fat Burn', min: at(0.4), max: at(0.6) - 1 },
    { name: 'Cardio', min: at(0.6), max: at(0.85) - 1 },
    { name: 'Peak', min: at(0.85), max: maxHr },
  ];
}

/**
 * Zones from lower bounds that the user passes, e.g. the zones of their app.
 * Each zone ends 1 bpm below the next one; the last ends at `maxHr` (or at
 * its own lower bound if that is higher). Bounds must go up. Samples below
 * the first bound go to an extra first zone, so they do not count in zone 1.
 */
export function customZones(zones: Array<{ name?: string; min: number }>, maxHr: number): HrZone[] {
  for (let i = 1; i < zones.length; i++) {
    if ((zones[i] as { min: number }).min <= (zones[i - 1] as { min: number }).min) {
      throw new RangeError('custom_zones: each min must be higher than the one before.');
    }
  }
  const out = zones.map((z, i) => {
    const next = zones[i + 1];
    return {
      name: z.name ?? `Zone ${i + 1}`,
      min: z.min,
      max: next ? next.min - 1 : Math.max(maxHr, z.min),
    };
  });
  const first = out[0];
  if (first && first.min > 0)
    out.unshift({ name: `Below ${first.name}`, min: 0, max: first.min - 1 });
  return out;
}

/**
 * Seconds spent in each zone.
 *
 * Each sample holds until the next one, so time is weighted by the real gap
 * rather than by the sample count. A gap is capped at MAX_GAP_MS, and the last
 * sample counts until `endMs` (also capped).
 */
export function timeInZones(samples: HrSample[], zones: HrZone[], endMs: number): HrZoneTime[] {
  const secs = zones.map(() => 0);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as HrSample;
    const next = i + 1 < samples.length ? (samples[i + 1] as HrSample).t : endMs;
    const dt = Math.min(Math.max(next - s.t, 0), MAX_GAP_MS) / 1000;
    let z = zones.length - 1;
    while (z > 0 && s.bpm < (zones[z] as HrZone).min) z--;
    secs[z] = (secs[z] as number) + dt;
  }
  const total = secs.reduce((a, b) => a + b, 0);
  return zones.map((zone, i) => ({
    ...zone,
    seconds: Math.round(secs[i] as number),
    minutes: Math.round((secs[i] as number) / 6) / 10,
    percent: total > 0 ? Math.round(((secs[i] as number) / total) * 1000) / 10 : 0,
  }));
}
