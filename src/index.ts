import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { guardMiddleware } from './auth/guard';
import type { Env } from './env';
import { buildServer } from './server';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('fitbit-logger-mcp — see /health and POST /mcp/:secret'));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-logger-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

app.post('/mcp/:secret', guardMiddleware(), async (c) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
});

export default app;
