import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthProvider } from '../../../src/providers/google-health';
import { createMockEnv, type MockKv } from '../../helpers/mock-env';

const SAVED = {
  name: 'users/1/dataTypes/exercise/dataPoints/123',
  dataSource: { platform: 'GOOGLE_WEB_API' },
  exercise: {
    displayName: 'Weights: Push',
    exerciseType: 'WEIGHTLIFTING',
    interval: {
      startTime: '2026-10-19T09:44:00Z',
      startUtcOffset: '37800s',
      endTime: '2026-10-19T11:01:00Z',
      endUtcOffset: '37800s',
    },
    activeDuration: '4620s',
    metricsSummary: { averageHeartRateBeatsPerMinute: 120 },
  },
};

function hr(iso: string, bpm: number) {
  return {
    heartRate: { beatsPerMinute: bpm, sampleTime: { physicalTime: iso, utcOffset: '37800s' } },
  };
}

function setup(existing: unknown[] = []) {
  const env = createMockEnv(
    {
      google_access_token: 'token',
      google_refresh_token: 'refresh',
      google_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    },
    { TIMEZONE: 'Australia/Adelaide' },
  );
  const cache = env.CACHE as unknown as MockKv;
  cache.get.mockImplementation(async (key: string, type?: string) => {
    const v = cache.__store.get(key);
    return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
  });
  const posts: unknown[] = [];
  let created = false;
  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname.endsWith('/settings')) return json({ timeZone: 'Australia/Adelaide' });
    if (url.pathname.includes('/heart-rate/')) {
      return json({
        dataPoints: [hr('2026-10-19T09:50:00Z', 110), hr('2026-10-19T10:30:00Z', 130)],
      });
    }
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      created = true;
      return json({ name: 'operations/abc', done: false });
    }
    return json({ dataPoints: created ? [...existing, SAVED] : existing });
  });
  vi.stubGlobal('fetch', fetch);
  return { provider: new GoogleHealthProvider(env), posts };
}

afterEach(() => vi.unstubAllGlobals());

describe('logWorkout', () => {
  it('sends local times as UTC with the offset, and the band average heart rate', async () => {
    const { provider, posts } = setup();
    const saved = await provider.logWorkout({
      date: '2026-10-19',
      start: '20:14',
      end: '21:31',
      exerciseType: 'WEIGHTLIFTING',
      name: 'Weights: Push',
      notes: 'Flat DB bench press: 15 kg x 10, 10, 10',
    });
    const body = posts[0] as { exercise: Record<string, unknown> };
    expect(body.exercise).toMatchObject({
      displayName: 'Weights: Push',
      exerciseType: 'WEIGHTLIFTING',
      interval: {
        startTime: '2026-10-19T09:44:00Z',
        startUtcOffset: '37800s',
        endTime: '2026-10-19T11:01:00Z',
        endUtcOffset: '37800s',
      },
      activeDuration: '4620s',
      metricsSummary: { averageHeartRateBeatsPerMinute: 120 },
      notes: 'Flat DB bench press: 15 kg x 10, 10, 10',
    });
    expect(saved.exerciseId).toBe('123');
    expect(saved.startTime_local).toBe('2026-10-19T20:14:00+10:30');
  });

  it('refuses times that overlap a workout Fitbit already has', async () => {
    const walk = {
      name: 'users/1/dataTypes/exercise/dataPoints/9',
      dataSource: { platform: 'FITBIT' },
      exercise: {
        displayName: 'Walk',
        exerciseType: 'WALKING',
        interval: { startTime: '2026-10-15T10:46:30Z', endTime: '2026-10-15T11:17:16Z' },
      },
    };
    const { provider, posts } = setup([walk]);
    await expect(
      provider.logWorkout({
        date: '2026-10-15',
        start: '20:50',
        end: '21:20',
        exerciseType: 'WEIGHTLIFTING',
        name: 'Weights: Pull',
      }),
    ).rejects.toThrow(/already has "Walk"/);
    expect(posts).toHaveLength(0);
  });

  it('rejects a window shorter than five minutes', async () => {
    const { provider } = setup();
    await expect(
      provider.logWorkout({
        date: '2026-10-19',
        start: '20:14',
        end: '20:16',
        exerciseType: 'WEIGHTLIFTING',
        name: 'Weights',
      }),
    ).rejects.toThrow(/between 5 minutes and 4 hours/);
  });
});
