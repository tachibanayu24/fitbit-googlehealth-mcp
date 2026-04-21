import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, invalidate } from '../../lib/cache';
import { assertIsoDate, todayJst } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { SleepLogSchema } from '../../providers/types';

const TIME_RE = /^\d{2}:\d{2}$/;

export function registerSleepWriteTool(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'log_sleep',
    {
      title: 'Log a manual sleep entry',
      description:
        'Record a sleep session that was not auto-detected. Duration is in milliseconds. Useful for nap logging or catch-up after forgetting to wear the device.',
      inputSchema: {
        date: z
          .string()
          .describe('YYYY-MM-DD of the morning after the sleep. Omit for today (JST).')
          .optional(),
        startTime: z
          .string()
          .regex(TIME_RE, 'Expected HH:mm')
          .describe('HH:mm, local time when sleep started.'),
        durationMs: z
          .number()
          .int()
          .positive()
          .describe('Duration of the sleep in milliseconds (e.g. 6.5h = 23400000).'),
      },
      outputSchema: SleepLogSchema.shape,
    },
    async ({ date, startTime, durationMs }) => {
      try {
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        const entry = await provider.logSleep({ date: d, startTime, durationMs });
        await invalidate(env, cacheKey('get_sleep', { date: d }));
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
    'delete_sleep_log',
    {
      title: 'Delete a sleep log entry',
      description:
        'Remove a previously logged sleep entry by its logId (from log_sleep output or from get_sleep[].logId).',
      inputSchema: {
        logId: z.number().int().describe('Sleep logId.'),
        date: z
          .string()
          .describe('YYYY-MM-DD the sleep was logged under. Used to invalidate caches.')
          .optional(),
      },
      outputSchema: { deleted: z.boolean(), logId: z.number() },
    },
    async ({ logId, date }) => {
      try {
        await provider.deleteSleepLog(logId);
        const d = date ?? todayJst();
        assertIsoDate(d, 'date');
        await invalidate(env, cacheKey('get_sleep', { date: d }));
        return {
          structuredContent: { deleted: true, logId },
          content: [{ type: 'text', text: `Deleted sleep log ${logId}.` }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
