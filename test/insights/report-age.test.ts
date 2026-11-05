import { describe, expect, it } from 'vitest';
import { ageContext } from '../../src/insights/report';

describe('ageContext', () => {
  it('skips age-based output when BIRTH_DATE is not set', () => {
    expect(ageContext({}, '2026-10-11')).toEqual({ age: undefined, hrMax: 180 });
  });

  it('uses BIRTH_DATE when set, for age and the derived max HR', () => {
    const { age, hrMax } = ageContext({ BIRTH_DATE: '1990-01-01' }, '2026-10-11');
    expect(age).toBeCloseTo(36.8, 1);
    expect(hrMax).toBeCloseTo(208 - 0.7 * 36.8, 5);
  });
});
