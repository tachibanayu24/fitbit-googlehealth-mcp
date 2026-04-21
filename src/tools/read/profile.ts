import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { ProfileSchema } from '../../providers/types';

export function registerProfileTool(server: McpServer, provider: HealthProvider, env: Env): void {
  server.registerTool(
    'get_profile',
    {
      title: 'Fitbit user profile',
      description:
        'Returns the authenticated user profile: display name, dates, unit system, timezone, and averages. Cached for 1 hour.',
      inputSchema: {},
      outputSchema: ProfileSchema.shape,
    },
    async () => {
      try {
        const data = await getCached(env, cacheKey('get_profile'), () => provider.getProfile());
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
