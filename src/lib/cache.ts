import type { Env } from '../env';

export const DEFAULT_CACHE_TTL_SEC = 60 * 60; // 1 hour

export async function getCached<T>(
  env: Env,
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlSec?: number } = {},
): Promise<T> {
  const hit = await env.CACHE.get(key, 'json');
  if (hit !== null && hit !== undefined) {
    return hit as T;
  }
  const fresh = await fetcher();
  await env.CACHE.put(key, JSON.stringify(fresh), {
    expirationTtl: opts.ttlSec ?? DEFAULT_CACHE_TTL_SEC,
  });
  return fresh;
}

export async function invalidate(env: Env, ...keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => env.CACHE.delete(k)));
}

/**
 * Current generation of a cache group. Put it into the group's keys; then
 * bumpCacheGeneration makes every key of the group stale at once, even keys
 * that cannot be listed (for example, every from/to pair of a range tool).
 */
export async function cacheGeneration(env: Env, group: string): Promise<string> {
  return (await env.CACHE.get(`gen:${group}`)) ?? '0';
}

export async function bumpCacheGeneration(env: Env, group: string): Promise<void> {
  await env.CACHE.put(`gen:${group}`, String(Date.now()));
}

/** Build a stable cache key from endpoint path + ordered args. */
export function cacheKey(endpoint: string, args: Record<string, unknown> = {}): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return parts ? `${endpoint}?${parts}` : endpoint;
}
