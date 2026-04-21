import { vi } from 'vitest';
import type { Env } from '../../src/env';

export function createMockKv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  const kv = {
    get: vi.fn(async (key: string, _type?: 'json' | 'text') => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
    getWithMetadata: vi.fn(),
    __store: store,
  };
  return kv;
}

export type MockKv = ReturnType<typeof createMockKv>;

export function createMockEnv(tokens: Record<string, string> = {}, overrides: Partial<Env> = {}) {
  return {
    TOKENS: createMockKv(tokens) as unknown as KVNamespace,
    CACHE: createMockKv() as unknown as KVNamespace,
    FITBIT_CLIENT_ID: 'test-client-id',
    FITBIT_CLIENT_SECRET: 'test-client-secret',
    MCP_SHARED_SECRET: 'test-shared-secret',
    ALLOWED_CIDRS: '160.79.104.0/21',
    ...overrides,
  } as Env;
}
