import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import type { HealthProvider } from '../providers/types';
import { registerActivityReadTools } from './read/activity';
import { registerBodyReadTools } from './read/body';
import { registerDevicesTool } from './read/devices';
import { registerHeartReadTools } from './read/heart';
import { registerMetricsReadTools } from './read/metrics';
import { registerNutritionReadTools } from './read/nutrition';
import { registerProfileTool } from './read/profile';
import { registerSleepReadTools } from './read/sleep';
import { registerActivityWriteTool } from './write/activity';
import { registerBodyWriteTools } from './write/body';
import { registerFoodWriteTools } from './write/food';
import { registerSleepWriteTool } from './write/sleep';

export function registerAllTools(server: McpServer, provider: HealthProvider, env: Env): void {
  // ---- Read (16) ----
  registerProfileTool(server, provider, env);
  registerDevicesTool(server, provider, env);
  registerActivityReadTools(server, provider, env);
  registerHeartReadTools(server, provider, env);
  registerSleepReadTools(server, provider, env);
  registerBodyReadTools(server, provider, env);
  registerNutritionReadTools(server, provider, env);
  registerMetricsReadTools(server, provider, env);

  // ---- Write (8) ----
  registerFoodWriteTools(server, provider, env);
  registerBodyWriteTools(server, provider, env);
  registerActivityWriteTool(server, provider, env);
  registerSleepWriteTool(server, provider, env);
}
