import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, cacheTtlForDate, normalizeRange, today } from '../../lib/date';
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
        'Sleep sessions for a date, including stage data (deep/light/rem/wake) when the device captured them. A night is attributed to the day it ENDS on. Defaults to today. Cached 1h.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD. Omit for today (server timezone).').optional(),
      },
      outputSchema: { sleep: z.array(SleepLogSchema) },
    },
    async ({ date }) => {
      try {
        const d = date ?? today();
        assertIsoDate(d, 'date');
        const sleep = await getCached(
          env,
          cacheKey('get_sleep', { date: d }),
          () => provider.getSleep(d),
          { ttlSec: cacheTtlForDate(d) },
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
        'Sleep sessions across a date range, attributed to the day each night ends on. Good for week-over-week comparisons. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { sleep: z.array(SleepLogSchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const sleep = await getCached(
          env,
          cacheKey('get_sleep_range', range),
          () => provider.getSleepRange(range.start, range.end),
          { ttlSec: cacheTtlForDate(range.end) },
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
