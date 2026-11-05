/**
 * Local-date helpers.
 *
 * Every tool with an optional `date` argument falls back to "today", which is
 * only meaningful in a specific zone. The original Fitbit-era implementation
 * hardcoded JST; this version reads the deployment's zone from the `TIMEZONE`
 * variable in wrangler.toml so a fork runs correctly wherever its owner lives.
 */

/** IANA zone used when no date is supplied. Overridden once per request. */
let activeTimeZone = 'UTC';

/**
 * Set the zone used by `today()`. Called from `buildServer(env)`.
 *
 * The value is a deployment-wide constant, so holding it at module scope is
 * safe even though a Worker isolate can serve more than one request.
 */
export function setTimeZone(tz: string | undefined): void {
  activeTimeZone = tz && tz.trim() !== '' ? tz : 'UTC';
}

export function getTimeZone(): string {
  return activeTimeZone;
}

/**
 * Format a Date/ms/ISO input as `YYYY-MM-DD` in the given IANA zone.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD` natively, which avoids
 * reassembling parts by hand. An unknown zone would make `Intl` throw, so it
 * falls back to UTC rather than failing the tool call.
 */
export function toLocalDateString(
  input: Date | string | number = new Date(),
  timeZone: string = activeTimeZone,
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid date input: ${String(input)}`);
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Today's date in the configured zone, as `YYYY-MM-DD`. */
export function today(timeZone: string = activeTimeZone): string {
  return toLocalDateString(new Date(), timeZone);
}

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in that zone and reading the wall-clock
 * back, so DST is handled by the platform rather than by a table here.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

// Building a formatter costs far more than using one, and reports call this thousands of times.
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zoneOffsetMs(instant: Date, timeZone?: string): number {
  timeZone = timeZone ?? activeTimeZone;
  try {
    const parts = partsFormatter(timeZone).formatToParts(instant);
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    // hour can come back as 24 at midnight in some ICU versions.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - instant.getTime()) / 60_000) * 60_000;
  } catch {
    return 0; // unknown zone -> behave as UTC
  }
}

/**
 * The UTC instants bounding a local calendar day, as `[start, end)`.
 *
 * Needed because instant-valued data (heart rate samples, weight readings) is
 * filtered on true UTC time, while a user means their own midnight. In
 * Europe/London during summer, "10 September" starts at 23:00Z on the 9th.
 *
 * The offset is resolved twice: once from the naive guess and once from the
 * corrected instant, so a day that begins on a DST boundary still lands right.
 */
const dayStarts = new Map<string, number>();

export function localDayStartUtc(date: string, timeZone?: string): Date {
  timeZone = timeZone ?? activeTimeZone;
  const key = `${timeZone}|${date}`;
  const known = dayStarts.get(key);
  if (known !== undefined) return new Date(known);
  const naive = Date.parse(`${date}T00:00:00Z`);
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  const refined = naive - zoneOffsetMs(new Date(firstPass), timeZone);
  if (Number.isFinite(refined)) dayStarts.set(key, refined);
  return new Date(refined);
}

/** Format an instant as local `HH:mm:ss` in the configured zone. */
export function toLocalTimeString(instant: Date | number, timeZone?: string): string {
  timeZone = timeZone ?? activeTimeZone;
  const d = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 19);
  }
}

const ZONED_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an ISO 8601 instant that carries an explicit offset (`Z` or `+05:00`).
 * A zone-less value is rejected: it is ambiguous, and guessing the zone is
 * exactly how double-offset bugs start.
 */
export function parseZonedIso(value: string, field: string): number {
  const ms = ZONED_ISO_RE.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `${field} must be ISO 8601 with an offset, e.g. 2026-09-26T11:15:00+05:00 (got: ${value})`,
    );
  }
  return ms;
}

/**
 * Local wall-clock time `HH:MM` on `date` in `timeZone`, as epoch ms.
 * `24:00` means the start of the next day. The second offset lookup makes
 * the result right on days when the zone changes its offset (DST).
 */
export function localTimeToUtcMs(
  date: string,
  hhmm: string,
  timeZone: string,
  field: string,
): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  const h = Number(m?.[1]);
  const min = Number(m?.[2]);
  if (!m || min > 59 || h > 24 || (h === 24 && min !== 0)) {
    throw new RangeError(`${field} must be HH:MM (00:00 to 24:00), got "${hhmm}".`);
  }
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, min);
  const guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  return wall - zoneOffsetMs(new Date(guess), timeZone);
}

/** Cache lifetime: 5 minutes while the day is still open, 1 hour for past days. */
export function cacheTtlForDate(date: string, timeZone?: string): number {
  return date >= today(timeZone) ? 300 : 3600;
}

/** Same rule for an instant: data after local midnight today is still changing. */
export function cacheTtlForInstant(ms: number, timeZone?: string): number {
  return ms > localDayStartUtc(today(timeZone), timeZone).getTime() ? 300 : 3600;
}

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function assertIsoDate(value: string, field = 'date'): asserts value is string {
  if (!ISO_DATE_RE.test(value)) {
    throw new RangeError(`${field} must be YYYY-MM-DD (got: ${value})`);
  }
}

/**
 * Return `start,end` as YYYY-MM-DD after validating both are present and
 * `start <= end`.
 */
export function normalizeRange(start: string, end: string): { start: string; end: string } {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) {
    throw new RangeError(`Range is inverted: start=${start} > end=${end}`);
  }
  return { start, end };
}
