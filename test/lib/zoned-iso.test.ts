import { describe, expect, it } from 'vitest';
import { cacheTtlForDate, localTimeToUtcMs, parseZonedIso } from '../../src/lib/date';

describe('parseZonedIso', () => {
  it('accepts an explicit offset, with or without seconds', () => {
    expect(parseZonedIso('2026-09-26T11:15+05:00', 'start')).toBe(
      Date.parse('2026-09-26T06:15:00Z'),
    );
    expect(parseZonedIso('2026-09-26T06:15:20Z', 'start')).toBe(Date.parse('2026-09-26T06:15:20Z'));
  });

  it('rejects a zone-less value instead of guessing the zone', () => {
    expect(() => parseZonedIso('2026-09-26T11:15:00', 'start')).toThrow(/offset/);
    expect(() => parseZonedIso('2026-09-26', 'end')).toThrow(/offset/);
  });
});

describe('cacheTtlForDate', () => {
  it('uses 5 minutes for today and later, 1 hour for past days', () => {
    expect(cacheTtlForDate('2999-01-01', 'UTC')).toBe(300);
    expect(cacheTtlForDate('2000-01-01', 'UTC')).toBe(3600);
  });
});

describe('localTimeToUtcMs', () => {
  it('turns a local HH:MM into an instant, with 24:00 as the next midnight', () => {
    expect(localTimeToUtcMs('2026-09-26', '11:15', 'Asia/Tashkent', 'start_time')).toBe(
      Date.parse('2026-09-26T06:15:00Z'),
    );
    expect(localTimeToUtcMs('2026-09-26', '24:00', 'Asia/Tashkent', 'end_time')).toBe(
      Date.parse('2026-09-26T19:00:00Z'),
    );
  });

  it('handles a DST day', () => {
    // New York moves to UTC-4 at 02:00 on 2026-03-08.
    expect(localTimeToUtcMs('2026-03-08', '12:00', 'America/New_York', 't')).toBe(
      Date.parse('2026-03-08T16:00:00Z'),
    );
  });

  it('rejects a bad time', () => {
    expect(() => localTimeToUtcMs('2026-09-26', '25:00', 'UTC', 'end_time')).toThrow(/HH:MM/);
    expect(() => localTimeToUtcMs('2026-09-26', '9:00', 'UTC', 'start_time')).toThrow(/HH:MM/);
  });
});
