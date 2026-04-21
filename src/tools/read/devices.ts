import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import { DeviceSchema } from '../../providers/types';

export function registerDevicesTool(server: McpServer, provider: HealthProvider, env: Env): void {
  server.registerTool(
    'list_devices',
    {
      title: 'Fitbit devices',
      description:
        'Lists Fitbit devices tied to the user (battery level, last sync time, model). Cached for 1 hour.',
      inputSchema: {},
      outputSchema: { devices: z.array(DeviceSchema) },
    },
    async () => {
      try {
        const devices = await getCached(env, cacheKey('list_devices'), () =>
          provider.listDevices(),
        );
        return {
          structuredContent: { devices },
          content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
