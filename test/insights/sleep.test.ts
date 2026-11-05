import { describe, expect, it } from 'vitest';
import { briefWakeMinutes, stageTotals } from '../../src/insights/sleep';

describe('stageTotals', () => {
  it('matches the Google Health app: brief wake-ups stay inside the stage they interrupt', () => {
    const summary = {
      minutesAsleep: '386',
      minutesAwake: '14',
      stagesSummary: [
        { type: 'LIGHT', minutes: '229' },
        { type: 'DEEP', minutes: '57' },
        { type: 'REM', minutes: '100' },
        { type: 'AWAKE', minutes: '14', count: '7' },
      ],
    };
    expect(stageTotals(summary)).toEqual({
      asleep: 386,
      awake: 14,
      deep: 57,
      rem: 100,
      light: 229,
      wakeUps: 7,
    });
  });

  it('leaves missing stages undefined rather than zero', () => {
    expect(stageTotals({ minutesAsleep: '30', minutesAwake: '2' })).toMatchObject({
      asleep: 30,
      deep: undefined,
      wakeUps: 0,
    });
  });
});

describe('briefWakeMinutes', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 13, 13) + min * 60_000).toISOString();
  const stage = (type: string, from: number, to: number) => ({
    type,
    startTime: at(from),
    endTime: at(to),
  });

  it('counts mid-night wake-ups under 5 minutes, as the 21 Oct night in Google Health (7h08)', () => {
    const stages = [
      stage('AWAKE', 0, 2),
      stage('LIGHT', 2, 100),
      stage('AWAKE', 100, 102),
      stage('DEEP', 102, 200),
      stage('AWAKE', 200, 203),
      stage('REM', 203, 300),
      stage('AWAKE', 300, 308),
      stage('LIGHT', 308, 430),
      stage('AWAKE', 430, 433),
    ];
    expect(briefWakeMinutes(stages)).toBe(5);
  });

  it('is zero when there is nothing between the first and last stage', () => {
    expect(briefWakeMinutes([stage('AWAKE', 0, 2), stage('LIGHT', 2, 90)])).toBe(0);
    expect(briefWakeMinutes(undefined)).toBe(0);
  });
});
