import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server';
import { createMockEnv } from '../helpers/mock-env';

type ToolRegistry = Record<string, { handler: (...args: unknown[]) => unknown }>;

/**
 * Parameter names a handler reads, taken from its destructured first
 * argument: `async ({ date, limit }) => ...` gives ["date", "limit"].
 * Undefined when the handler takes the whole input object (`async (input)`),
 * because such a handler passes on every listed parameter.
 */
function handlerParams(handler: (...args: unknown[]) => unknown): string[] | undefined {
  const src = handler.toString();
  if (/^async\s*\(\s*\w+\s*\)/.test(src)) return undefined;
  const m = /^async\s*\(\s*(?:\{([^}]*)\})?/.exec(src);
  if (!m) throw new Error(`Cannot read the parameters of: ${src.slice(0, 80)}`);
  return (m[1] ?? '')
    .split(',')
    .map((p) => p.trim().split(/[\s:=]/)[0] ?? '')
    .filter(Boolean)
    .sort();
}

async function listTools(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'schema-sync-test', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tools/list schemas', () => {
  it('lists exactly the parameters that each handler reads', async () => {
    const server = buildServer(createMockEnv({}, { ENABLE_WRITE_TOOLS: 'true' }));
    const registry = (server as unknown as { _registeredTools: ToolRegistry })._registeredTools;
    const tools = await listTools(server);
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const listed = Object.keys(tool.inputSchema.properties ?? {}).sort();
      const handler = registry[tool.name]?.handler;
      expect(handler, tool.name).toBeDefined();
      const read = handlerParams(handler as (...args: unknown[]) => unknown);
      if (read)
        expect({ tool: tool.name, params: listed }).toEqual({ tool: tool.name, params: read });
    }
  });

  it('publishes the new parameters with their defaults', async () => {
    const tools = await listTools(buildServer(createMockEnv()));
    const props = (name: string) =>
      (tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as Record<
        string,
        { default?: unknown }
      >;

    const list = props('get_exercise_list');
    expect(Object.keys(list).sort()).toEqual(
      ['beforeDate', 'from', 'limit', 'min_duration_seconds', 'to'].sort(),
    );
    expect(list.limit?.default).toBe(20);
    expect(list.min_duration_seconds?.default).toBe(60);

    const intraday = props('get_heart_rate_intraday');
    expect(Object.keys(intraday).sort()).toEqual(
      ['date', 'detailLevel', 'end_time', 'fields', 'start_time'].sort(),
    );
    expect(intraday.start_time?.default).toBe('00:00');
    expect(intraday.end_time?.default).toBe('24:00');
    expect(intraday.fields?.default).toBe('full');
  });
});
