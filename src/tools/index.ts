import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import type { HealthProvider } from '../providers/types';
import { registerDevicesTool } from './read/devices';
import { registerProfileTool } from './read/profile';

export function registerAllTools(server: McpServer, provider: HealthProvider, env: Env): void {
  // ---- Read: profile / devices ----
  registerProfileTool(server, provider, env);
  registerDevicesTool(server, provider, env);

  // Activity / heart / sleep / body / nutrition / metrics reads land in
  // subsequent commits. Write tools land in M8.
}
