import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { setTimeZone } from './lib/date';
import { FitbitProvider } from './providers/fitbit';
import { GoogleHealthProvider } from './providers/google-health';
import type { HealthProvider } from './providers/types';
import { registerAllTools } from './tools';

/**
 * Pick the backend for this request.
 *
 * Defaults to Google Health: the legacy Fitbit Web API is being decommissioned
 * in September 2026, so a deployment that says nothing should get the surviving
 * one. `HEALTH_PROVIDER=fitbit` opts back into the old path.
 */
export function buildProvider(env: Env): HealthProvider {
  return env.HEALTH_PROVIDER === 'fitbit' ? new FitbitProvider(env) : new GoogleHealthProvider(env);
}

export function buildServer(env: Env): McpServer {
  // Tools resolve "today" against this; it must be set before any tool runs.
  setTimeZone(env.TIMEZONE);

  const server = new McpServer({
    name: 'fitbit-googlehealth-mcp',
    version: '0.2.0',
  });
  registerAllTools(server, buildProvider(env), env);
  return server;
}
