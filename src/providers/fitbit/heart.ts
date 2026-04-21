import { z } from 'zod';
import type { HeartRateDay, HeartRateIntraday, IntradayDetailLevelT } from '../types';
import { HeartRateDaySchema, HeartRateIntradayPointSchema } from '../types';
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

const HeartRateIntradayResponseSchema = z.object({
  'activities-heart': z.array(HeartRateDaySchema).optional(),
  // Fitbit sometimes omits the intraday block entirely (observed for Charge 6
  // on days with sparse coverage). Treat as optional and fall back to an
  // empty points array so callers can reason about it uniformly.
  'activities-heart-intraday': z
    .object({
      dataset: z.array(HeartRateIntradayPointSchema),
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
  return {
    date,
    detailLevel,
    restingHeartRate: day?.value.restingHeartRate,
    heartRateZones: day?.value.heartRateZones,
    points: intraday?.dataset ?? [],
  };
}
