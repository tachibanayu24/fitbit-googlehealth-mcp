#!/usr/bin/env tsx
/**
 * Ground-truth probe for the Google Health API.
 *
 *   GOOGLE_ACCESS_TOKEN=ya29... pnpm run probe:google
 *
 * Or, against a deployed Worker's stored token:
 *   GOOGLE_ACCESS_TOKEN=$(pnpm wrangler kv key get --remote --binding=TOKENS google_access_token) \
 *     pnpm run probe:google
 *
 * Walks every endpoint the provider depends on and prints, per data type,
 * whether it responded and which value fields actually came back. The provider
 * infers a handful of rollup field names (`countSum`, `millimetersSum`, the
 * per-activity-level breakdown) from the discovery document rather than from
 * observed traffic; this script is how those get confirmed against real data.
 *
 * Read-only: it lists and rolls up, and never writes or deletes.
 */

import { loadEnv } from './load-env';

loadEnv();

const BASE = 'https://health.googleapis.com/v4';

const token = process.env.GOOGLE_ACCESS_TOKEN;
if (!token) {
  console.error('Error: GOOGLE_ACCESS_TOKEN is not set.');
  console.error('');
  console.error('  Run `pnpm run setup:google` first, then either add it to .env:');
  console.error('    GOOGLE_ACCESS_TOKEN=ya29...');
  console.error('  or pull the one the Worker is using:');
  console.error(
    '    GOOGLE_ACCESS_TOKEN=$(pnpm wrangler kv key get --remote --binding=TOKENS google_access_token) pnpm run probe:google',
  );
  process.exit(1);
}

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const TODAY = isoDate(0);
const WEEK_AGO = isoDate(-7);
const TOMORROW = isoDate(1);

type Probe = {
  label: string;
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
};

function civil(date: string) {
  const [y, m, d] = date.split('-');
  return { date: { year: Number(y), month: Number(m), day: Number(d) } };
}

function listProbe(dataType: string, filter?: string): Probe {
  return {
    label: `list ${dataType}`,
    path: `/users/me/dataTypes/${dataType}/dataPoints`,
    query: filter ? { filter, pageSize: '3' } : { pageSize: '3' },
  };
}

function dailyRollupProbe(dataType: string): Probe {
  return {
    label: `dailyRollUp ${dataType}`,
    path: `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`,
    method: 'POST',
    body: {
      range: { start: civil(WEEK_AGO), end: civil(TOMORROW) },
      windowSizeDays: 1,
    },
  };
}

const PROBES: Probe[] = [
  { label: 'identity', path: '/users/me/identity' },
  { label: 'profile', path: '/users/me/profile' },
  { label: 'settings', path: '/users/me/settings' },
  { label: 'pairedDevices', path: '/users/me/pairedDevices' },

  // Daily-summary types: `.date` filters take a bare YYYY-MM-DD.
  listProbe('daily-resting-heart-rate', `daily_resting_heart_rate.date >= "${WEEK_AGO}"`),
  listProbe('daily-oxygen-saturation', `daily_oxygen_saturation.date >= "${WEEK_AGO}"`),
  listProbe('daily-respiratory-rate', `daily_respiratory_rate.date >= "${WEEK_AGO}"`),
  listProbe('daily-heart-rate-variability', `daily_heart_rate_variability.date >= "${WEEK_AGO}"`),
  listProbe('daily-vo2-max', `daily_vo2_max.date >= "${WEEK_AGO}"`),
  listProbe(
    'daily-sleep-temperature-derivations',
    `daily_sleep_temperature_derivations.date >= "${WEEK_AGO}"`,
  ),

  // Sample types: physical_time needs an explicit UTC "Z".
  listProbe('heart-rate', `heart_rate.sample_time.physical_time >= "${TODAY}T00:00:00Z"`),
  listProbe('weight', `weight.sample_time.physical_time >= "${WEEK_AGO}T00:00:00Z"`),
  listProbe('body-fat', `body_fat.sample_time.physical_time >= "${WEEK_AGO}T00:00:00Z"`),

  // Interval types: civil_start_time is wall-clock, so NO "Z".
  listProbe('sleep', `sleep.interval.civil_end_time >= "${WEEK_AGO}T00:00:00"`),
  listProbe('exercise', `exercise.interval.civil_start_time >= "${WEEK_AGO}T00:00:00"`),
  listProbe('nutrition-log', `nutrition_log.interval.civil_start_time >= "${WEEK_AGO}T00:00:00"`),
  listProbe('hydration-log', `hydration_log.interval.civil_start_time >= "${WEEK_AGO}T00:00:00"`),

  // Rollups backing get_daily_summary and get_activity_timeseries.
  dailyRollupProbe('steps'),
  dailyRollupProbe('distance'),
  dailyRollupProbe('total-calories'),
  dailyRollupProbe('floors'),
  dailyRollupProbe('activity-level'),
  dailyRollupProbe('active-zone-minutes'),
  dailyRollupProbe('active-energy-burned'),
];

/** Collect leaf field paths so the real value keys are visible at a glance. */
function leafPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.length ? leafPaths(value[0], `${prefix}[]`, depth + 1) : [];
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1),
    );
  }
  return [`${prefix}=${JSON.stringify(value)}`];
}

async function run(p: Probe): Promise<void> {
  const url = new URL(BASE + p.path);
  for (const [k, v] of Object.entries(p.query ?? {})) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      method: p.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(p.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: p.body ? JSON.stringify(p.body) : undefined,
    });
  } catch (err) {
    console.log(`✗ ${p.label.padEnd(46)} network error: ${String(err)}`);
    return;
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200).replace(/\s+/g, ' ');
    try {
      msg = (JSON.parse(text).error?.message ?? msg).slice(0, 200);
    } catch {
      // keep the raw slice
    }
    console.log(`✗ ${p.label.padEnd(46)} HTTP ${res.status}  ${msg}`);
    return;
  }

  const body = JSON.parse(text) as Record<string, unknown>;
  const rows =
    (body.dataPoints as unknown[]) ??
    (body.rollupDataPoints as unknown[]) ??
    (body.pairedDevices as unknown[]);

  if (Array.isArray(rows)) {
    if (rows.length === 0) {
      console.log(`· ${p.label.padEnd(46)} OK, 0 rows`);
      return;
    }
    const fields = leafPaths(rows[0]).slice(0, 14);
    console.log(`✓ ${p.label.padEnd(46)} ${rows.length} row(s)`);
    for (const f of fields) console.log(`      ${f}`);
  } else {
    const fields = leafPaths(body).slice(0, 14);
    console.log(`✓ ${p.label.padEnd(46)} object`);
    for (const f of fields) console.log(`      ${f}`);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('Google Health API probe');
  console.log(`  today=${TODAY}  window=${WEEK_AGO}..${TODAY}`);
  console.log('─'.repeat(72));
  // Sequential so the output stays readable and ordered.
  for (const p of PROBES) await run(p);
  console.log('─'.repeat(72));
  console.log('');
  console.log('Legend: ✓ returned data   · reachable but empty   ✗ failed');
  console.log('');
  console.log('A ✗ with HTTP 403 usually means that scope was not granted —');
  console.log('re-run `pnpm run setup:google` after adding it on the Data Access page.');
  console.log('');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
