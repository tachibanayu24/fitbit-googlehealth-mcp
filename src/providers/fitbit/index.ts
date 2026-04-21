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
import { FitbitClient } from './client';
import { listDevices } from './device';
import { getHeartRateIntraday, getHeartRateRange } from './heart';
import { getProfile } from './profile';

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
  getSleep(_date: string): Promise<SleepLog[]> {
    return Promise.reject(new Error('not_implemented: getSleep'));
  }
  getSleepRange(_start: string, _end: string): Promise<SleepLog[]> {
    return Promise.reject(new Error('not_implemented: getSleepRange'));
  }
  getBodyLog(_start: string, _end: string): Promise<BodyLog> {
    return Promise.reject(new Error('not_implemented: getBodyLog'));
  }
  getFoodLog(_date: string): Promise<FoodLog> {
    return Promise.reject(new Error('not_implemented: getFoodLog'));
  }

  // ---------- Read: metrics ----------
  getSpO2(_start: string, _end: string): Promise<SpO2Day[]> {
    return Promise.reject(new Error('not_implemented: getSpO2'));
  }
  getRespiratoryRate(_start: string, _end: string): Promise<RespiratoryRateDay[]> {
    return Promise.reject(new Error('not_implemented: getRespiratoryRate'));
  }
  getSkinTemperature(_start: string, _end: string): Promise<SkinTempDay[]> {
    return Promise.reject(new Error('not_implemented: getSkinTemperature'));
  }
  getHRV(_start: string, _end: string): Promise<HrvDay[]> {
    return Promise.reject(new Error('not_implemented: getHRV'));
  }
  getCardioFitness(_date: string): Promise<CardioFitness> {
    return Promise.reject(new Error('not_implemented: getCardioFitness'));
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
