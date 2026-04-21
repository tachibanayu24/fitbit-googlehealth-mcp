import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { normalizeRange } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { BodyFatLogSchema, WeightLogSchema } from '../../providers/types';

export function registerBodyReadTools(server: McpServer, provider: HealthProvider, env: Env): void {
  server.registerTool(
    'get_body_log',
    {
      title: 'Weight and body-fat log',
      description:
        'Logged weight and body fat entries across a date range. BMI is returned when Fitbit computed it. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: {
        weight: z.array(WeightLogSchema).optional(),
        fat: z.array(BodyFatLogSchema).optional(),
      },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const body = await getCached(env, cacheKey('get_body_log', range), () =>
          provider.getBodyLog(range.start, range.end),
        );
        return {
          structuredContent: body,
          content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
