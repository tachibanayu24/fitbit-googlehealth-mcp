import { z } from 'zod';
import type { CardioFitness, HrvDay, RespiratoryRateDay, SkinTempDay, SpO2Day } from '../types';
import {
  CardioFitnessSchema,
  HrvDaySchema,
  RespiratoryRateDaySchema,
  SkinTempDaySchema,
  SpO2DaySchema,
} from '../types';
import type { FitbitClient } from './client';

// SpO2 range: top-level array response (no outer key)
const SpO2RangeResponseSchema = z.array(SpO2DaySchema);

export async function getSpO2(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<SpO2Day[]> {
  return client.requestJson(SpO2RangeResponseSchema, {
    path: `/1/user/-/spo2/date/${start}/${end}.json`,
  });
}

// Respiratory rate range: wrapped as `{ br: [...] }`
const RespiratoryRateResponseSchema = z.object({
  br: z.array(RespiratoryRateDaySchema),
});

export async function getRespiratoryRate(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<RespiratoryRateDay[]> {
  const response = await client.requestJson(RespiratoryRateResponseSchema, {
    path: `/1/user/-/br/date/${start}/${end}.json`,
  });
  return response.br;
}

// Skin temperature range: wrapped as `{ tempSkin: [...] }`
const SkinTempResponseSchema = z.object({
  tempSkin: z.array(SkinTempDaySchema),
});

export async function getSkinTemperature(
  client: FitbitClient,
  start: string,
  end: string,
): Promise<SkinTempDay[]> {
  const response = await client.requestJson(SkinTempResponseSchema, {
    path: `/1/user/-/temp/skin/date/${start}/${end}.json`,
  });
  return response.tempSkin;
}

// HRV range: wrapped as `{ hrv: [...] }`
const HrvResponseSchema = z.object({
  hrv: z.array(HrvDaySchema),
});

export async function getHRV(client: FitbitClient, start: string, end: string): Promise<HrvDay[]> {
  const response = await client.requestJson(HrvResponseSchema, {
    path: `/1/user/-/hrv/date/${start}/${end}.json`,
  });
  return response.hrv;
}

// Cardio fitness (VO2 max): wrapped as `{ cardioScore: [...] }`
const CardioFitnessResponseSchema = z.object({
  cardioScore: z.array(CardioFitnessSchema),
});

export async function getCardioFitness(client: FitbitClient, date: string): Promise<CardioFitness> {
  const response = await client.requestJson(CardioFitnessResponseSchema, {
    path: `/1/user/-/cardioscore/date/${date}.json`,
  });
  return response.cardioScore[0] ?? { dateTime: date, value: {} };
}
