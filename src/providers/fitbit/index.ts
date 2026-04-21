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
import {
  deleteActivityLog,
  getActivityTimeSeries,
  getDailySummary,
  getExerciseList,
  logActivity,
} from './activity';
import { deleteBodyFatLog, deleteWeightLog, getBodyLog, logBodyFat, logWeight } from './body';
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
import { deleteFoodLog, deleteWaterLog, getFoodLog, logFood, logMeal, logWater } from './nutrition';
import { getProfile } from './profile';
import { deleteSleepLog, getSleep, getSleepRange, logSleep } from './sleep';

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

  // ---------- Write ----------
  logFood(input: LogFoodInput): Promise<FoodLogEntry> {
    return logFood(this.client, input);
  }
  logMeal(input: LogMealInput): Promise<FoodLogEntry[]> {
    return logMeal(this.client, input);
  }
  logWater(input: LogWaterInput): Promise<WaterLogEntry> {
    return logWater(this.client, input);
  }
  logWeight(input: LogWeightInput): Promise<WeightLog> {
    return logWeight(this.client, input);
  }
  logBodyFat(input: LogBodyFatInput): Promise<BodyFatLog> {
    return logBodyFat(this.client, input);
  }
  logActivity(input: LogActivityInput): Promise<ExerciseLog> {
    return logActivity(this.client, input);
  }
  logSleep(input: LogSleepInput): Promise<SleepLog> {
    return logSleep(this.client, input);
  }
  deleteFoodLog(logId: number): Promise<void> {
    return deleteFoodLog(this.client, logId);
  }
  deleteWaterLog(logId: number): Promise<void> {
    return deleteWaterLog(this.client, logId);
  }
  deleteWeightLog(logId: number): Promise<void> {
    return deleteWeightLog(this.client, logId);
  }
  deleteBodyFatLog(logId: number): Promise<void> {
    return deleteBodyFatLog(this.client, logId);
  }
  deleteActivityLog(logId: number): Promise<void> {
    return deleteActivityLog(this.client, logId);
  }
  deleteSleepLog(logId: number): Promise<void> {
    return deleteSleepLog(this.client, logId);
  }
}
