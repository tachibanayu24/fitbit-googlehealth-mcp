import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import type { HealthProvider } from '../providers/types';
import { registerInsightsTools } from './insights';
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
import { registerPresetTools } from './write/preset';
import { registerSleepWriteTool } from './write/sleep';
import { registerWorkoutWriteTools } from './write/workout';

export function registerAllTools(server: McpServer, provider: HealthProvider, env: Env): void {
  // ---- Read ----
  registerProfileTool(server, provider, env);
  registerDevicesTool(server, provider, env);
  registerActivityReadTools(server, provider, env);
  registerHeartReadTools(server, provider, env);
  registerSleepReadTools(server, provider, env);
  registerBodyReadTools(server, provider, env);
  registerNutritionReadTools(server, provider, env);
  registerMetricsReadTools(server, provider, env);
  if (env.HEALTH_PROVIDER !== 'fitbit') registerInsightsTools(server, env);

  // Write, delete and preset tools are off by default. They also need the
  // write scopes from `pnpm run setup:google -- --write`.
  // "activity" serves only the workout tools, which need just the activity write scope.
  if (env.ENABLE_WRITE_TOOLS === 'true' || env.ENABLE_WRITE_TOOLS === 'activity') {
    registerWorkoutWriteTools(server, provider, env);
  }
  if (env.ENABLE_WRITE_TOOLS !== 'true') return;

  // ---- Write / delete ----
  registerFoodWriteTools(server, provider, env);
  registerBodyWriteTools(server, provider, env);
  registerActivityWriteTool(server, provider, env);
  registerSleepWriteTool(server, provider, env);

  // ---- Meal presets (server-side PFC storage, workaround for Fitbit
  //      Create Food dropping macros) ----
  registerPresetTools(server, provider, env);
}
