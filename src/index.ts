import { Hono } from 'hono';
import { guardMiddleware } from './auth/guard';
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

app.post('/mcp/:secret', guardMiddleware(), (c) => {
  // The MCP Streamable HTTP transport body is wired in a later milestone
  // (after OAuth bootstrap + Fitbit client + tool registration). Until then
  // we respond 501 so guard-only traffic is still observable.
  return c.text('mcp_transport_not_yet_wired', 501);
});

export default app;
