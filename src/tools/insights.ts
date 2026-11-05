import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../env';
import { buildReport } from '../insights/report';
import { toolErrorResult } from '../lib/errors';

const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const dateArg = z.string().describe('YYYY-MM-DD, the morning after the night. Omit for today.');

const WHOOP_METHOD = {
  recovery:
    'Fitted to a real Whoop export: HRV about 80% (deep sleep weighted, against the last 14 ' +
    'nights), sleeping resting HR 12%, breathing 8%. Short sleep, skin temperature over +0.5 C ' +
    'or SpO2 under 94% pull it down. Calibrating for the first 4 nights.',
  strain:
    'Whoop day runs from falling asleep to the next sleep. Every minute is weighted by its ' +
    'share of heart rate reserve and put on the 0 to 21 curve fitted to 3,215 real Whoop ' +
    'workouts. Lifting reads low because heart rate stays low.',
  sleep:
    'Need is 7h30 plus extra after a hard day (37 min after strain 15) plus half of the last ' +
    'shortfall (up to 3h), minus naps. Performance is 75% hours against need, 15% consistency ' +
    'and 10% efficiency. Hours follow Google: wake-ups under 5 min count as sleep.',
  stress: 'Whoop 0 to 3 from heart rate against resting and max, eased off while moving.',
  caveat:
    "Whoop's formulas are private, so these are close copies built from Fitbit data and can " +
    'sit a few points off a real Whoop. HRV and resting HR here are the Whoop-style sleep ' +
    'figures; the google values are what your Google Health app shows.',
};

/** Hour-by-hour averages, so the model gets the day's shape without 288 raw points. */
function hourly(values: Array<number | null>, per = 12) {
  const out: Array<{ hour: number; avg: number; max: number }> = [];
  for (let h = 0; h * per < values.length; h++) {
    const xs = values.slice(h * per, (h + 1) * per).filter((v): v is number => v !== null);
    if (!xs.length) continue;
    const avg = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    out.push({ hour: h, avg, max: Math.max(...xs) });
  }
  return out;
}

export function registerInsightsTools(server: McpServer, env: Env): void {
  server.registerTool(
    'get_whoop_scores',
    {
      title: 'Whoop-style scores',
      description:
        'The Whoop-style numbers for one day, made from Fitbit data: ' +
        'Recovery % (green 67+, yellow 34 to 66, red 33 and under) with its parts, Sleep ' +
        'performance % against Sleep need, hours, efficiency, consistency and sleep stress, ' +
        'Strain 0 to 21 with its target, zones 1 to 5 and each activity, Stress 0 to 3 by ' +
        "hour, tonight's sleep planner, dashboard figures against the 30-day average, 30 days " +
        'of history and how each score works. Quote its numbers as they are.',
      inputSchema: { date: dateArg.optional() },
    },
    async ({ date }) => {
      try {
        const r = await buildReport(env, { date, days: 30 });
        const w = r.whoop;
        if (!w) return asText({ date: r.date, error: 'No data for this day yet.' });
        const { heartRate, from: _from, to: _to, ...strain } = w.strain;
        const { levels, ...stress } = w.stress;
        const byBucket = new Array<number | null>(288).fill(null);
        for (const [k, v] of levels) if (k >= 0 && k < 288) byBucket[k] = v;
        return asText({
          date: r.date,
          isToday: r.isToday,
          ...w,
          strain: { ...strain, heartRateByHour: hourly(heartRate) },
          stress: { ...stress, byHour: hourly(byBucket).map(({ hour, avg }) => ({ hour, avg })) },
          method: WHOOP_METHOD,
        });
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_day_snapshot',
    {
      title: 'Full day snapshot with scores',
      description:
        'Everything for one day in one call: guidance (headline, training advice, actions), ' +
        'Readiness (no score until 3 earlier nights, then calibrating until 7, building until ' +
        '14), Sleep score (classic Fitbit method), Strain 0 to 21 (Whoop-style), ' +
        'weekly load, Resilience, last night (stages incl. brief wake-ups, sleeping heart rate, ' +
        'SpO2 coverage, breathing per stage), vitals against your normal range and the HRV norm ' +
        'for your age, steps by hour, sitting time, auto-detected workouts and health flags. ' +
        'Use its numbers as they are. Use this first for "how am I" or any daily check.',
      inputSchema: { date: dateArg.optional() },
    },
    async ({ date }) => {
      try {
        const r = await buildReport(env, { date, days: 7 });
        return asText({ date: r.date, realAge: r.realAge, dataStart: r.dataStart, ...r.today });
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_trends',
    {
      title: 'Trends and weekly review',
      description:
        'Daily rows of every score and vital for the last N days, with averages and the Sleep ' +
        'Profile (bedtime, wake, consistency, chronotype, deep and REM share, 7 day sleep debt). ' +
        'Use for weekly or monthly reviews and "how is my sleep going".',
      inputSchema: {
        days: z.number().int().min(7).max(90).describe('Default 7.').optional(),
        date: dateArg.optional(),
      },
    },
    async ({ days, date }) => {
      try {
        const r = await buildReport(env, { date, days: days ?? 7 });
        return asText({ date: r.date, sleepProfile: r.sleepProfile, ...r.trends });
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_body_age',
    {
      title: 'Body age',
      description:
        "Body age against real age, on Whoop's published method: resting HR, steps, sleep " +
        'duration and regularity, weekly zone minutes and VO2 max. Needs BIRTH_DATE to be set. ' +
        'No number until 7 full days of wear; factors without enough data say what ' +
        'they are waiting for. A wellness estimate, never a medical claim.',
      inputSchema: { date: dateArg.optional() },
    },
    async ({ date }) => {
      try {
        return asText((await buildReport(env, { date, days: 30 })).bodyAge);
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
