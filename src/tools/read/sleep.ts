import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, normalizeRange, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { SleepLogSchema } from '../../providers/types';

export function registerSleepReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_sleep',
    {
      title: 'Sleep logs for one day',
      description:
        'Fitbit sleep logs (v1.2) for a date, including stage data (deep/light/rem/wake) when the device captured them. Defaults to today (JST). Cached 1h.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (JST).').optional(),
      },
      outputSchema: { sleep: z.array(SleepLogSchema) },
    },
    async ({ date }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const sleep = await getCached(env, cacheKey('get_sleep', { date: d }), () =>
          provider.getSleep(d),
        );
        return {
          structuredContent: { sleep },
          content: [{ type: 'text', text: JSON.stringify(sleep, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_sleep_range',
    {
      title: 'Sleep logs across a date range',
      description:
        'Fitbit sleep logs (v1.2) across a date range. Good for week-over-week comparisons. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { sleep: z.array(SleepLogSchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const sleep = await getCached(env, cacheKey('get_sleep_range', range), () =>
          provider.getSleepRange(range.start, range.end),
        );
        return {
          structuredContent: { sleep },
          content: [{ type: 'text', text: JSON.stringify(sleep, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
