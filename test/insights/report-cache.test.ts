import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReport, forgetReports, peekReport, reportKey } from '../../src/insights/report';
import { setTimeZone, today } from '../../src/lib/date';
import { addDays } from '../../src/providers/google-health/client';
import { createMockEnv, createMockKv, type MockKv } from '../helpers/mock-env';

const rows = Array.from({ length: 35 }, (_, k) => ({
  date: `2026-10-${String(k + 1).padStart(2, '0')}`,
  steps: k < 28 ? 1000 : 9000,
  partial: false,
}));

function saved(at: number) {
  return JSON.stringify({
    at,
    report: { date: today(), trends: { days: 35, averages: {}, rows }, generatedAt: 'x' },
  });
}

function envWith(value?: string) {
  setTimeZone('Australia/Adelaide');
  const env = createMockEnv();
  const kv = env.CACHE as unknown as MockKv;
  kv.get.mockImplementation(async (key: string, type?: string) => {
    const v = kv.__store.get(key);
    return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
  });
  if (value) kv.__store.set(reportKey(today(), 35), value);
  return env;
}

afterEach(() => vi.unstubAllGlobals());

describe('report cache', () => {
  it('serves a fresh saved report without calling Google', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = await buildReport(envWith(saved(Date.now() - 20_000)), { days: 30 });
    expect(fetch).not.toHaveBeenCalled();
    expect(r.trends.rows).toHaveLength(30);
  });

  it('cuts the 7 day view from the shared build and averages only those days', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const r = await buildReport(envWith(saved(Date.now())), { days: 7 });
    expect(r.trends.days).toBe(7);
    expect(r.trends.rows.map((x) => x.date)[0]).toBe('2026-10-29');
    expect(r.trends.averages.steps).toBe(9000);
  });

  it('peek returns an old copy marked stale, and nothing when none is saved', async () => {
    const old = await peekReport(envWith(saved(Date.now() - 3_600_000)), { days: 30 });
    expect(old?.stale).toBe(true);
    const recent = await peekReport(envWith(saved(Date.now())), { days: 7 });
    expect(recent?.stale).toBe(false);
    expect(await peekReport(envWith(), { days: 30 })).toBeUndefined();
  });

  it('a refresh tap reuses parts fetched in the last minute and refetches older ones', async () => {
    const env = envWith(saved(Date.now() - 20_000));
    const kv = env.CACHE as unknown as MockKv;
    const stored = JSON.parse(kv.__store.get(reportKey(today(), 35)) as string);
    const start = '2026-10-10' > addDays(today(), -34) ? '2026-10-10' : addDays(today(), -34);
    stored.tiers = {
      night: { at: Date.now() - 30_000, start, value: { rows: [] } },
      activity: { at: Date.now() - 600_000, start, gen: '0', value: { rows: [] } },
    };
    kv.__store.set(reportKey(today(), 35), JSON.stringify(stored));
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        paths.push(new URL(String(input)).pathname);
        return new Response('{}', { status: 200 });
      }),
    );
    const tokens = createMockKv({
      google_access_token: 'a',
      google_refresh_token: 'r',
      google_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    });
    const live = {
      ...env,
      TOKENS: tokens as unknown as KVNamespace,
      DATA_START: '2026-10-10',
    };
    await buildReport(live, { days: 30, fresh: true }).catch(() => undefined);
    expect(paths.some((p) => p.includes('/daily-heart-rate-variability/'))).toBe(false);
    expect(paths.some((p) => p.includes('/active-zone-minutes/'))).toBe(true);
  });

  it('forgetReports clears the saved builds for that day', async () => {
    const env = envWith(saved(Date.now()));
    await forgetReports(env, today());
    expect(await peekReport(env, { days: 30 })).toBeUndefined();
  });
});
