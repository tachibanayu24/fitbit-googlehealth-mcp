import type { Env } from '../../env';
import type {
  ActivityResourceT,
  BodyFatLog,
  BodyLog,
  CardioFitness,
  DailySummary,
  Device,
  ExerciseLog,
  FoodLog,
  FoodLogEntry,
  HealthProvider,
  HeartRateDay,
  HeartRateIntraday,
  HrvDay,
  IntradayDetailLevelT,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  Profile,
  RespiratoryRateDay,
  SkinTempDay,
  SleepLog,
  SpO2Day,
  TimeSeries,
  WaterLogEntry,
  WeightLog,
} from '../types';
import { getActivityTimeSeries, getDailySummary, getExerciseList } from './activity';
import { getBodyLog } from './body';
import { FitbitClient } from './client';
import { listDevices } from './device';
import { getHeartRateIntraday, getHeartRateRange } from './heart';
import {
  getCardioFitness,
  getHRV,
  getRespiratoryRate,
  getSkinTemperature,
  getSpO2,
} from './metrics';
import { getFoodLog } from './nutrition';
import { getProfile } from './profile';
import { getSleep, getSleepRange } from './sleep';

/**
 * FitbitProvider — implements HealthProvider against the 2026-era
 * Fitbit Web API (api.fitbit.com). Will be replaced by a
 * GoogleHealthProvider before the 2026/09 Fitbit Web API turndown.
 */
export class FitbitProvider implements HealthProvider {
  private readonly client: FitbitClient;

  constructor(env: Env) {
    this.client = new FitbitClient(env);
  }

  // ---------- Read: profile / devices ----------
  getProfile(): Promise<Profile> {
    return getProfile(this.client);
  }

  listDevices(): Promise<Device[]> {
    return listDevices(this.client);
  }

  // ---------- Read: activity ----------
  getDailySummary(date: string): Promise<DailySummary> {
    return getDailySummary(this.client, date);
  }
  getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries> {
    return getActivityTimeSeries(this.client, resource, start, end);
  }
  getExerciseList(opts: { beforeDate?: string; limit?: number }): Promise<ExerciseLog[]> {
    return getExerciseList(this.client, opts);
  }

  // ---------- Read: heart rate ----------
  getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]> {
    return getHeartRateRange(this.client, start, end);
  }
  getHeartRateIntraday(
    date: string,
    detailLevel: IntradayDetailLevelT,
  ): Promise<HeartRateIntraday> {
    return getHeartRateIntraday(this.client, date, detailLevel);
  }

  // ---------- Read: sleep / body / nutrition ----------
  getSleep(date: string): Promise<SleepLog[]> {
    return getSleep(this.client, date);
  }
  getSleepRange(start: string, end: string): Promise<SleepLog[]> {
    return getSleepRange(this.client, start, end);
  }
  getBodyLog(start: string, end: string): Promise<BodyLog> {
    return getBodyLog(this.client, start, end);
  }
  getFoodLog(date: string): Promise<FoodLog> {
    return getFoodLog(this.client, date);
  }

  // ---------- Read: metrics ----------
  getSpO2(start: string, end: string): Promise<SpO2Day[]> {
    return getSpO2(this.client, start, end);
  }
  getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]> {
    return getRespiratoryRate(this.client, start, end);
  }
  getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]> {
    return getSkinTemperature(this.client, start, end);
  }
  getHRV(start: string, end: string): Promise<HrvDay[]> {
    return getHRV(this.client, start, end);
  }
  getCardioFitness(date: string): Promise<CardioFitness> {
    return getCardioFitness(this.client, date);
  }

  // ---------- Write (implemented in M7) ----------
  logFood(_input: LogFoodInput): Promise<FoodLogEntry> {
    return Promise.reject(new Error('not_implemented: logFood'));
  }
  logMeal(_input: LogMealInput): Promise<FoodLogEntry[]> {
    return Promise.reject(new Error('not_implemented: logMeal'));
  }
  logWater(_input: LogWaterInput): Promise<WaterLogEntry> {
    return Promise.reject(new Error('not_implemented: logWater'));
  }
  logWeight(_input: LogWeightInput): Promise<WeightLog> {
    return Promise.reject(new Error('not_implemented: logWeight'));
  }
  logBodyFat(_input: LogBodyFatInput): Promise<BodyFatLog> {
    return Promise.reject(new Error('not_implemented: logBodyFat'));
  }
  logActivity(_input: LogActivityInput): Promise<ExerciseLog> {
    return Promise.reject(new Error('not_implemented: logActivity'));
  }
  logSleep(_input: LogSleepInput): Promise<SleepLog> {
    return Promise.reject(new Error('not_implemented: logSleep'));
  }
  deleteFoodLog(_logId: number): Promise<void> {
    return Promise.reject(new Error('not_implemented: deleteFoodLog'));
  }
}
