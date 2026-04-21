import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { BodyFatLogSchema, WeightLogSchema } from '../../providers/types';

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export function registerBodyWriteTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'log_weight',
    {
      title: 'Log a weight entry (kg)',
      description: 'Record a weight reading. BMI is computed by Fitbit if a height is on file.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        weightKg: z.number().positive().describe('Weight in kilograms, e.g. 65.2.'),
        time: z
          .string()
          .regex(TIME_RE, 'Expected HH:mm or HH:mm:ss')
          .describe('HH:mm(:ss). Defaults to now.')
          .optional(),
      },
      outputSchema: WeightLogSchema.shape,
    },
    async ({ date, weightKg, time }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const entry = await provider.logWeight({ date: d, weightKg, time });
        await invalidate(env, cacheKey('get_daily_summary', { date: d }));
        return {
          structuredContent: entry,
          content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'log_body_fat',
    {
      title: 'Log a body-fat percentage entry',
      description: 'Record a body-fat percentage reading (e.g. from a smart scale).',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
        fatPercent: z.number().min(1).max(60).describe('Body fat %. e.g. 18.5.'),
        time: z
          .string()
          .regex(TIME_RE, 'Expected HH:mm or HH:mm:ss')
          .describe('HH:mm(:ss). Defaults to now.')
          .optional(),
      },
      outputSchema: BodyFatLogSchema.shape,
    },
    async ({ date, fatPercent, time }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const entry = await provider.logBodyFat({ date: d, fatPercent, time });
        return {
          structuredContent: entry,
          content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
