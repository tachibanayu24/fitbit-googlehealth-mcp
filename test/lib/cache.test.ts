import { describe, expect, it } from 'vitest';
import { bumpCacheGeneration, cacheGeneration, cacheKey } from '../../src/lib/cache';
import { createMockEnv } from '../helpers/mock-env';

describe('cacheKey', () => {
  it('returns the endpoint as-is when there are no args', () => {
    expect(cacheKey('/1/user/-/profile.json')).toBe('/1/user/-/profile.json');
  });

  it('serializes args in alphabetical order', () => {
    expect(cacheKey('/x', { b: '2', a: '1' })).toBe('/x?a=1&b=2');
  });

  it('filters out undefined and null values', () => {
    expect(cacheKey('/x', { a: '1', b: undefined, c: null })).toBe('/x?a=1');
  });

  it('stringifies non-string values', () => {
    expect(cacheKey('/x', { limit: 10, days: 7 })).toBe('/x?days=7&limit=10');
  });
});

describe('cacheGeneration', () => {
  it('starts at 0 and changes after a bump, so old keys no longer match', async () => {
    const env = createMockEnv();
    const before = await cacheGeneration(env, 'list');
    expect(before).toBe('0');
    await bumpCacheGeneration(env, 'list');
    const after = await cacheGeneration(env, 'list');
    expect(after).not.toBe(before);
    expect(cacheKey('list', { from: '2026-09-01', gen: after })).not.toBe(
      cacheKey('list', { from: '2026-09-01', gen: before }),
    );
  });
});
