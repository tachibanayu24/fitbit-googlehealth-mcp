#!/usr/bin/env tsx
/**
 * End-to-end check of GoogleHealthProvider against the live API.
 *
 *   pnpm run verify:provider        # reads GOOGLE_ACCESS_TOKEN from .env
 *
 * The unit tests cover pure functions; this exercises the real read methods
 * and prints what each one actually produced. It is the only way to catch a
 * field-path mistake, which typechecks perfectly and silently yields
 * `undefined` at runtime.
 *
 * Read-only — it calls no write or delete method.
 *
 * The provider expects a Workers `Env`, so a Map-backed stub stands in for the
 * KV namespaces. The stored token is given a future expiry so the provider
 * uses it directly instead of trying to refresh.
 */

import type { Env } from '../src/env';
import { GoogleHealthProvider } from '../src/providers/google-health';
import { loadEnv } from './load-env';

loadEnv();

const token = process.env.GOOGLE_ACCESS_TOKEN;
if (!token) {
  console.error('Error: GOOGLE_ACCESS_TOKEN is not set (add it to .env).');
  console.error('Run `pnpm run setup:google` to mint one; they last about an hour.');
  process.exit(1);
}

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

const env = {
  TOKENS: memoryKv({
    google_access_token: token,
    google_refresh_token: 'unused-in-this-check',
    google_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  }),
  CACHE: memoryKv(),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  MCP_SHARED_SECRET: 'unused',
  ALLOWED_CIDRS: '',
  TIMEZONE: 'Europe/London',
} as Env;

const provider = new GoogleHealthProvider(env);

function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const TODAY = day(0);
const WEEK_AGO = day(-7);

/** Compact one-line preview so a wrong field shows up as `undefined`. */
function preview(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'undefined';
  return json.length > 260 ? `${json.slice(0, 260)}…` : json;
}

let failures = 0;

async function check(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    const empty =
      result === undefined || result === null || (Array.isArray(result) && result.length === 0);
    console.log(`${empty ? '·' : '✓'} ${label}`);
    console.log(`    ${preview(result)}`);
  } catch (err) {
    failures++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ ${label}`);
    console.log(`    ${msg.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('GoogleHealthProvider live verification');
  console.log(`  today=${TODAY}  window=${WEEK_AGO}..${TODAY}`);
  console.log('─'.repeat(72));

  await check('getProfile', () => provider.getProfile());
  await check('listDevices', () => provider.listDevices());
  await check('getDailySummary(today)', () => provider.getDailySummary(TODAY));
  await check('getActivityTimeSeries(steps)', () =>
    provider.getActivityTimeSeries('steps', WEEK_AGO, TODAY),
  );
  await check('getActivityTimeSeries(distance)', () =>
    provider.getActivityTimeSeries('distance', WEEK_AGO, TODAY),
  );
  await check('getActivityTimeSeries(minutesSedentary)', () =>
    provider.getActivityTimeSeries('minutesSedentary', WEEK_AGO, TODAY),
  );
  await check('getExerciseList', () => provider.getExerciseList({ limit: 2 }));
  await check('getHeartRateRange', () => provider.getHeartRateRange(WEEK_AGO, TODAY));
  await check('getHeartRateIntraday(15min)', () => provider.getHeartRateIntraday(TODAY, '15min'));
  await check('getSleep(today)', () => provider.getSleep(TODAY));
  await check('getBodyLog', () => provider.getBodyLog(WEEK_AGO, TODAY));
  await check('getFoodLog(today)', () => provider.getFoodLog(TODAY));
  await check('getSpO2', () => provider.getSpO2(WEEK_AGO, TODAY));
  await check('getRespiratoryRate', () => provider.getRespiratoryRate(WEEK_AGO, TODAY));
  await check('getSkinTemperature', () => provider.getSkinTemperature(WEEK_AGO, TODAY));
  await check('getHRV', () => provider.getHRV(WEEK_AGO, TODAY));
  await check('getCardioFitness', () => provider.getCardioFitness(TODAY));

  console.log('─'.repeat(72));
  console.log(`${failures === 0 ? 'No method threw.' : `${failures} method(s) threw.`}`);
  console.log('Legend: ✓ returned data   · empty (no data for the window)   ✗ threw');
  console.log('');
  console.log('Check the previews: a field reading `undefined` where you expect a');
  console.log('number usually means a wrong field path, not missing data.');
  console.log('');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
