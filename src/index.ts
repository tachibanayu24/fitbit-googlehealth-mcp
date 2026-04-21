import { Hono } from 'hono';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('fitbit-logger-mcp — see /health and POST /mcp/:secret'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-logger-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

// MCP Streamable HTTP endpoint is wired up in a later milestone.
// app.post('/mcp/:secret', ...);

export default app;
