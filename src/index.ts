import { WorkerEntrypoint } from 'cloudflare:workers';
import { StreamableHTTPTransport } from '@hono/mcp';
import { type Context, Hono } from 'hono';
import { gatewayGuard, guardMiddleware } from './auth/guard';
import { dashboard } from './dashboard/routes';
import type { Env } from './env';
import { homePage, privacyPage, termsPage } from './pages';
import { buildServer } from './server';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.html(homePage));
app.get('/privacy', (c) => c.html(privacyPage));
app.get('/terms', (c) => c.html(termsPage));

app.get('/app/', (c) => c.redirect('/app', 301));
app.route('/app', dashboard);

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-googlehealth-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

const mcpHandler = async (c: Context<{ Bindings: Env }>) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
};

app.post('/mcp', guardMiddleware<Env>(), mcpHandler);
const gateway = new Hono<{ Bindings: Env }>();
gateway.post('/gateway/mcp', gatewayGuard<Env>(), mcpHandler);

export class GatewayService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return gateway.fetch(request, this.env);
  }
}

export default app;
