import { localDayStartUtc } from '../../lib/date';
import { addDays } from './client';

/**
 * How a data type expresses time, which decides both the filter field path
 * and the literal format the API will accept. Getting this wrong is the most
 * common source of HTTP 400 from `dataPoints:list`.
 */
export type TimeField =
  | 'interval' // {type}.interval.civil_start_time — zone-less ISO 8601
  | 'sample' // {type}.sample_time.physical_time — RFC-3339, needs "Z"
  | 'daily' // {type}.date — bare YYYY-MM-DD
  | 'none'; // catalog types (food) carry no timestamp at all

/** kebab-case data type id → snake_case name used inside filter expressions. */
export function filterName(dataType: string): string {
  return dataType.replace(/-/g, '_');
}

/**
 * Field path a filter expression must use for this data type.
 *
 * `sleep` is the documented exception: it only supports filtering on the END
 * of the session, so a night that starts before midnight is still attributed
 * to the morning it ends on.
 */
export function filterPath(dataType: string, timeField: TimeField): string {
  if (timeField === 'none') return '';
  const n = filterName(dataType);
  if (dataType === 'sleep') return 'sleep.interval.civil_end_time';
  switch (timeField) {
    case 'sample':
      return `${n}.sample_time.physical_time`;
    case 'daily':
      return `${n}.date`;
    default:
      return `${n}.interval.civil_start_time`;
  }
}

/**
 * Build a closed-open `[start, end)` filter across whole local days.
 *
 * `endDate` is inclusive in this project's tool surface (it mirrors Fitbit's
 * range endpoints), so it is advanced by one day to produce the exclusive
 * upper bound the API expects. The API supports only `>=` and `<` — never
 * `<=` or `>`.
 */
export function dayRangeFilter(
  dataType: string,
  timeField: TimeField,
  startDate: string,
  endDate: string,
  timeZone?: string,
): string | undefined {
  const path = filterPath(dataType, timeField);
  if (!path) return undefined;

  const exclusiveEnd = addDays(endDate, 1);
  switch (timeField) {
    case 'sample': {
      // Physical time is a true instant, so the bounds are the UTC moments at
      // which the user's local day begins and ends — not UTC midnight, which
      // would shift the window by the zone offset.
      const from = localDayStartUtc(startDate, timeZone)
        .toISOString()
        .replace(/\.\d+Z$/, 'Z');
      const to = localDayStartUtc(exclusiveEnd, timeZone)
        .toISOString()
        .replace(/\.\d+Z$/, 'Z');
      return `${path} >= "${from}" AND ${path} < "${to}"`;
    }
    case 'daily':
      return `${path} >= "${startDate}" AND ${path} < "${exclusiveEnd}"`;
    default:
      // Civil time is zone-less wall-clock: no "Z", or the API rejects it.
      return `${path} >= "${startDate}T00:00:00" AND ${path} < "${exclusiveEnd}T00:00:00"`;
  }
}

/** Convenience wrapper for a single local day. */
export function singleDayFilter(
  dataType: string,
  timeField: TimeField,
  date: string,
  timeZone?: string,
): string | undefined {
  return dayRangeFilter(dataType, timeField, date, date, timeZone);
}
