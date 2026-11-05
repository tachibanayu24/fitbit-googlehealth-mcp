import { describe, expect, it } from 'vitest';
import { fromWearable, sourceFamily } from '../../../src/providers/google-health/client';

describe('sourceFamily', () => {
  it('limits device data to Google and Fitbit wearables', () => {
    for (const type of ['daily-heart-rate-variability', 'steps', 'heart-rate']) {
      expect(sourceFamily(type)).toBe('users/me/dataSourceFamilies/google-wearables');
    }
  });

  it('keeps every source for data logged by hand', () => {
    for (const type of ['nutrition-log', 'hydration-log', 'weight', 'body-fat']) {
      expect(sourceFamily(type)).toBeUndefined();
    }
  });

  it('sends no family for sleep, which the API rejects, or for exercise', () => {
    expect(sourceFamily('sleep')).toBeUndefined();
    expect(sourceFamily('exercise')).toBeUndefined();
  });
});

describe('fromWearable', () => {
  const fitbit = { dataSource: { platform: 'FITBIT' } };
  const watch = { dataSource: { platform: 'HEALTH_KIT' } };

  it('drops Apple Health sleep but keeps Fitbit sleep', () => {
    expect(fromWearable('sleep', fitbit)).toBe(true);
    expect(fromWearable('sleep', watch)).toBe(false);
  });

  it('keeps band and API-saved workouts but drops Apple Health ones', () => {
    expect(fromWearable('exercise', fitbit)).toBe(true);
    expect(fromWearable('exercise', { dataSource: { platform: 'GOOGLE_WEB_API' } })).toBe(true);
    expect(fromWearable('exercise', watch)).toBe(false);
  });

  it('leaves types filtered by the API alone', () => {
    expect(fromWearable('steps', watch)).toBe(true);
  });
});
