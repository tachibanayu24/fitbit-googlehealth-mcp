import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import type { HealthProvider } from '../providers/types';
import { registerActivityReadTools } from './read/activity';
import { registerDevicesTool } from './read/devices';
import { registerHeartReadTools } from './read/heart';
import { registerProfileTool } from './read/profile';

export function registerAllTools(server: McpServer, provider: HealthProvider, env: Env): void {
  // ---- Read ----
  registerProfileTool(server, provider, env);
  registerDevicesTool(server, provider, env);
  registerActivityReadTools(server, provider, env);
  registerHeartReadTools(server, provider, env);

  // sleep / body / nutrition / metrics reads land in subsequent commits.
  // Write tools land in M8.
}
