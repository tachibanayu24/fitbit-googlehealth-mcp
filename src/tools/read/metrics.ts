import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, normalizeRange, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import {
  CardioFitnessSchema,
  HrvDaySchema,
  RespiratoryRateDaySchema,
  SkinTempDaySchema,
  SpO2DaySchema,
} from '../../providers/types';

export function registerMetricsReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_spo2',
    {
      title: 'Blood oxygen saturation (SpO2)',
      description: 'Nightly SpO2 averages (min / avg / max) across a date range. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(SpO2DaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(env, cacheKey('get_spo2', range), () =>
          provider.getSpO2(range.start, range.end),
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_respiratory_rate',
    {
      title: 'Respiratory (breathing) rate',
      description:
        'Sleep-derived breathing rate per day, broken down by sleep stage when available. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(RespiratoryRateDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(env, cacheKey('get_respiratory_rate', range), () =>
          provider.getRespiratoryRate(range.start, range.end),
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_skin_temperature',
    {
      title: 'Nightly skin-temperature variation',
      description:
        'Overnight skin-temperature delta relative to the user baseline. Only available on supported devices. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(SkinTempDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(env, cacheKey('get_skin_temperature', range), () =>
          provider.getSkinTemperature(range.start, range.end),
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_hrv',
    {
      title: 'Heart rate variability (HRV)',
      description:
        'Nightly HRV (daily RMSSD and deep-sleep RMSSD). Useful for recovery trending. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(HrvDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(env, cacheKey('get_hrv', range), () =>
          provider.getHRV(range.start, range.end),
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_cardio_fitness',
    {
      title: 'Cardio Fitness Score (VO2 max)',
      description:
        'VO2 max estimate from Fitbit. Returned as a range string (e.g. "45-49") or a numeric value depending on device. Defaults to today (JST). Cached 1h.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
      },
      outputSchema: CardioFitnessSchema.shape,
    },
    async ({ date }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const data = await getCached(env, cacheKey('get_cardio_fitness', { date: d }), () =>
          provider.getCardioFitness(d),
        );
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
