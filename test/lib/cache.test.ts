import { describe, expect, it } from 'vitest';
import { cacheKey } from '../../src/lib/cache';

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
