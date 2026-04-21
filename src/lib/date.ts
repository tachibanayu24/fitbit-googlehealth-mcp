const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Format a Date/ms/ISO string as `YYYY-MM-DD` in JST.
 * Defaults to "today in JST" when no argument is given.
 */
export function toJstDateString(input: Date | string | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid date input: ${String(input)}`);
  }
  const shifted = new Date(d.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function todayJst(): string {
  return toJstDateString();
}

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function assertIsoDate(value: string, field = 'date'): asserts value is string {
  if (!ISO_DATE_RE.test(value)) {
    throw new RangeError(`${field} must be YYYY-MM-DD (got: ${value})`);
  }
}

/**
 * Return `start,end` as YYYY-MM-DD after validating both are present and
 * `start <= end`. Used by Fitbit range endpoints.
 */
export function normalizeRange(start: string, end: string): { start: string; end: string } {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) {
    throw new RangeError(`Range is inverted: start=${start} > end=${end}`);
  }
  return { start, end };
}
