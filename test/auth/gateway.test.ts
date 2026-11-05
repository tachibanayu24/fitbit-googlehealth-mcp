import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/dashboard/routes', async () => {
  const { Hono } = await import('hono');
  return { dashboard: new Hono() };
});

import publicApp, * as worker from '../../src/index';

const env = {
  MCP_SHARED_SECRET: 'legacy',
  GATEWAY_SHARED_SECRET: 'gateway',
  ALLOWED_CIDRS: '160.79.104.0/21',
};
const request = (path: string, secret?: string) =>
  new Request(`https://test.local${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'CF-Connecting-IP': '1.2.3.4',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });

describe('gateway route', () => {
  const app = {
    fetch: (req: Request, bindings: unknown) => {
      const Entry = (
        worker as unknown as {
          GatewayService: new (
            ctx: ExecutionContext,
            env: unknown,
          ) => { fetch(req: Request): Promise<Response> };
        }
      ).GatewayService;
      return new Entry({} as ExecutionContext, bindings).fetch(req);
    },
  };
  it('keeps the gateway route off the public Worker', async () => {
    expect((await publicApp.fetch(request('/gateway/mcp', 'gateway'), env as never)).status).toBe(
      404,
    );
  });
  it('serves the real private tool catalogue', async () => {
    const req = request('/gateway/mcp', 'gateway');
    const catalogue = new Request(req, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const response = await app.fetch(catalogue, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('inputSchema');
  });
  it('keeps other routes off the private entrypoint', async () => {
    expect((await app.fetch(request('/mcp', 'gateway'), env)).status).toBe(404);
  });
  it('rejects an unset gateway secret', async () => {
    const response = await app.fetch(request('/gateway/mcp', 'gateway'), {
      ...env,
      GATEWAY_SHARED_SECRET: undefined,
    } as never);
    expect(response.status).toBe(401);
  });
  it.each([undefined, 'wrong', 'legacy'])('rejects the credential %s', async (secret) => {
    expect((await app.fetch(request('/gateway/mcp', secret), env as never)).status).toBe(401);
  });
  it('accepts the gateway bearer outside Anthropic addresses', async () => {
    const response = await app.fetch(request('/gateway/mcp', 'gateway'), env as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('protocolVersion');
  });
  it('rejects an API key without a bearer', async () => {
    const req = request('/gateway/mcp');
    req.headers.set('x-api-key', 'gateway');
    expect((await app.fetch(req, env as never)).status).toBe(401);
  });
  it('accepts the gateway bearer without a client address', async () => {
    const req = request('/gateway/mcp', 'gateway');
    req.headers.delete('CF-Connecting-IP');
    expect((await app.fetch(req, env as never)).status).toBe(200);
  });
  it('keeps the legacy CIDR guard', async () => {
    expect((await publicApp.fetch(request('/mcp', 'legacy'), env as never)).status).toBe(403);
    expect((await publicApp.fetch(request('/mcp', 'gateway'), env as never)).status).toBe(401);
  });
});
