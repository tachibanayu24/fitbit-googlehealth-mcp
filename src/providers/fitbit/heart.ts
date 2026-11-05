import { z } from 'zod';
import { localDayStartUtc } from '../../lib/date';
import { isoLocal, isoUtc } from '../google-health/hr-series';
import type { HeartRateDay, HeartRateIntraday, IntradayDetailLevelT } from '../types';
import { HeartRateDaySchema } from '../types';
import type { FitbitClient } from './client';

const HeartRateRangeResponseSchema = z.object({
  'activities-heart': z.array(HeartRateDaySchema),
});

export async function getHeartRateRange(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<HeartRateDay[]> {
  const response = await client.requestJson(HeartRateRangeResponseSchema, {
    path: `/1/user/-/activities/heart/date/${start}/${end}.json`,
  });
  return response['activities-heart'];
}

/** Fitbit's own intraday point: local `HH:mm:ss` plus the value. */
const FitbitIntradayPointSchema = z.object({ time: z.string(), value: z.number() });

const HeartRateIntradayResponseSchema = z.object({
  'activities-heart': z.array(HeartRateDaySchema).optional(),
  // Fitbit sometimes omits the intraday block entirely (observed for Charge 6
  // on days with sparse coverage). Treat as optional and fall back to an
  // empty points array so callers can reason about it uniformly.
  'activities-heart-intraday': z
    .object({
      dataset: z.array(FitbitIntradayPointSchema),
      datasetInterval: z.number().optional(),
      datasetType: z.string().optional(),
    })
    .optional(),
});

export async function getHeartRateIntraday(
  client: FitbitClient,
  date: string,
  detailLevel: IntradayDetailLevelT,
): Promise<HeartRateIntraday> {
  const response = await client.requestJson(HeartRateIntradayResponseSchema, {
    path: `/1/user/-/activities/heart/date/${date}/1d/${detailLevel}.json`,
  });
  const day = response['activities-heart']?.[0];
  const intraday = response['activities-heart-intraday'];
  // Fitbit returns local wall-clock times only. Rebuild the instant from the
  // local midnight; this ignores a DST change inside the day (legacy path).
  const dayStart = localDayStartUtc(date).getTime();
  const points = (intraday?.dataset ?? []).map((p) => {
    const [h = 0, m = 0, sec = 0] = p.time.split(':').map(Number);
    const t = dayStart + (h * 3600 + m * 60 + sec) * 1000;
    const off = Date.parse(`${date}T00:00:00Z`) - dayStart;
    return { time_utc: isoUtc(t), time_local: isoLocal(t, off), bpm: p.value };
  });
  return {
    date,
    detailLevel,
    restingHeartRate: day?.value.restingHeartRate,
    heartRateZones: day?.value.heartRateZones,
    points,
  };
}
