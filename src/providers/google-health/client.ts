import type { ZodType } from 'zod';
import type { Env } from '../../env';
import { GoogleApiError, GoogleRateLimitError } from '../../lib/errors';
import { parseRetryAfter, sleep } from '../../lib/rate-limit';
import { getAccessToken, invalidateAccessToken } from './oauth';

export const GOOGLE_HEALTH_API_BASE = 'https://health.googleapis.com/v4';

export type GoogleHealthRequest = {
  /** Path relative to the v4 base, e.g. `/users/me/dataTypes/steps/dataPoints`. */
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  /** JSON request body for writes and the `:rollUp` / `:batchDelete` verbs. */
  json?: unknown;
  /** Accept header. Defaults to JSON; the TCX export returns XML. */
  accept?: string;
};

/** Maximum `dataPoints` pages walked by `listAll` before giving up. */
const MAX_PAGES = 20;

const WEARABLES_FAMILY = 'users/me/dataSourceFamilies/google-wearables';
// Logged by hand, so the wearables family would hide them.
const MANUAL_TYPES = new Set(['nutrition-log', 'hydration-log', 'weight', 'body-fat']);
// Sleep rejects a family and API-saved workouts have none, so both are filtered after listing.
const NO_FAMILY_TYPES = new Set(['sleep', 'exercise']);

/** Old phone and watch data must not mix into the Fitbit baselines. */
export function sourceFamily(dataType: string): string | undefined {
  if (MANUAL_TYPES.has(dataType) || NO_FAMILY_TYPES.has(dataType)) return undefined;
  return WEARABLES_FAMILY;
}

export function fromWearable(dataType: string, point: unknown): boolean {
  if (!NO_FAMILY_TYPES.has(dataType)) return true;
  const platform = (point as { dataSource?: { platform?: string } }).dataSource?.platform;
  return platform === 'FITBIT' || (dataType === 'exercise' && platform === 'GOOGLE_WEB_API');
}

export class GoogleHealthClient {
  /**
   * One token lookup shared by parallel requests. Without it, a fan-out of
   * heart-rate chunks near token expiry starts several refreshes at once, and
   * KV rejects the extra writes to the same key.
   */
  private tokenPromise?: Promise<string>;

  constructor(private readonly env: Env) {}

  private accessToken(): Promise<string> {
    this.tokenPromise ??= getAccessToken(this.env).catch((err: unknown) => {
      this.tokenPromise = undefined;
      throw err;
    });
    return this.tokenPromise;
  }

  async requestJson<T>(schema: ZodType<T>, req: GoogleHealthRequest): Promise<T> {
    const body = await this.requestText(req);
    // A 200 with an empty body is normal for batchDelete and some patches.
    const raw = body.trim() === '' ? {} : JSON.parse(body);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const preview = body.length > 600 ? `${body.slice(0, 600)}…` : body;
      throw new GoogleApiError(
        200,
        `Schema validation failed at ${req.path}: ${parsed.error.message}\nRaw body preview: ${preview}`,
        req.path,
      );
    }
    return parsed.data;
  }

  async requestText(req: GoogleHealthRequest): Promise<string> {
    // `path` may contain a `:verb` suffix (`:dailyRollUp`), which `new URL()`
    // would otherwise be free to reinterpret — concatenate instead of resolving.
    const url = new URL(GOOGLE_HEALTH_API_BASE + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 3; // original + one token refresh + one rate-limit retry
    while (true) {
      attempt++;
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: req.accept ?? 'application/json',
      };

      let body: BodyInit | undefined;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['Content-Type'] = 'application/json';
      }

      const method = req.method ?? 'GET';
      const t0 = Date.now();
      const res = await fetch(url, { method, headers, body });
      const ms = Date.now() - t0;

      if (res.status === 401 && attempt === 1) {
        console.log(`[google-health] ${method} ${req.path} → 401 after ${ms}ms, refreshing token`);
        this.tokenPromise = undefined;
        await invalidateAccessToken(this.env);
        continue;
      }

      if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'));
        console.log(
          `[google-health] ${method} ${req.path} → ${res.status}, sleeping ${waitSec}s before retry`,
        );
        await sleep(waitSec * 1000);
        continue;
      }

      const text = await res.text();
      if (res.status === 429) {
        throw new GoogleRateLimitError(parseRetryAfter(res.headers.get('Retry-After')), req.path);
      }
      if (!res.ok) {
        console.log(
          `[google-health] ${method} ${req.path} → ${res.status} after ${ms}ms: ${text.slice(0, 300)}`,
        );
        throw new GoogleApiError(res.status, text, req.path);
      }
      return text;
    }
  }

  /**
   * Walk `dataPoints:list` pages and concatenate the results.
   *
   * The API returns at most `pageSize` rows per call (25 for sleep/exercise,
   * up to 10000 elsewhere) and signals more with `nextPageToken`. `limit`
   * stops the walk early once enough rows are collected; MAX_PAGES bounds the
   * worst case so a wide range cannot hang the Worker. `fields` is the
   * standard Google field mask; it shrinks large listings a lot.
   */
  async listAll(
    dataType: string,
    opts: {
      filter?: string;
      pageSize?: number;
      limit?: number;
      fields?: string;
      allSources?: boolean;
    } = {},
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const text = await this.requestText({
        path: `/users/me/dataTypes/${dataType}/dataPoints`,
        query: {
          filter: opts.filter,
          pageSize: opts.pageSize,
          pageToken,
          fields: opts.fields,
          dataSourceFamily: opts.allSources ? undefined : sourceFamily(dataType),
        },
      });
      const body = JSON.parse(text) as {
        dataPoints?: unknown[];
        nextPageToken?: string;
      };
      out.push(...(body.dataPoints ?? []).filter((point) => fromWearable(dataType, point)));

      if (opts.limit !== undefined && out.length >= opts.limit) {
        return out.slice(0, opts.limit);
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return out;
  }

  /**
   * `dataPoints:dailyRollUp` — the Google Health equivalent of Fitbit's
   * daily-summary and time-series endpoints. Returns one bucket per local day.
   *
   * Two shape details the reference CLI proves and the docs gloss over:
   *  - the range is a CivilTimeInterval whose `end` is EXCLUSIVE, so the
   *    caller's inclusive `endDate` is advanced by one day here;
   *  - `windowSizeDays` is documented as optional (default 1) but the live API
   *    returns HTTP 400 when it is omitted, so it is always sent.
   */
  async dailyRollUp(
    dataType: string,
    startDate: string,
    endDate: string,
    opts: { windowSizeDays?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.postRollUp(`/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
      range: { start: civilDate(startDate), end: civilDate(addDays(endDate, 1)) },
      windowSizeDays: opts.windowSizeDays ?? 1,
      dataSourceFamily: sourceFamily(dataType),
    });
  }

  /**
   * `dataPoints:rollUp` — sub-daily aggregation over a physical-time range.
   * Used for intraday-style buckets, where `windowSize` is a duration string
   * such as `"900s"` for 15-minute buckets.
   */
  async rollUp(
    dataType: string,
    startTimeIso: string,
    endTimeIso: string,
    windowSize: string,
    fields?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.postRollUp(
      `/users/me/dataTypes/${dataType}/dataPoints:rollUp`,
      {
        range: { startTime: startTimeIso, endTime: endTimeIso },
        windowSize,
        pageSize: 10000,
        dataSourceFamily: sourceFamily(dataType),
      },
      fields,
    );
  }

  /**
   * Both rollup verbs return `rollupDataPoints` (not `dataPoints`) and
   * paginate by re-POSTing the same body with a `pageToken` added.
   */
  private async postRollUp(
    path: string,
    body: Record<string, unknown>,
    fields?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const text = await this.requestText({
        path,
        method: 'POST',
        query: fields ? { fields } : undefined,
        json: pageToken ? { ...body, pageToken } : body,
      });
      const parsed = JSON.parse(text) as {
        rollupDataPoints?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      };
      out.push(...(parsed.rollupDataPoints ?? []));
      if (!parsed.nextPageToken) return out;
      pageToken = parsed.nextPageToken;
    }
    // Partial data would look like real data (for example, too few minutes).
    throw new Error(`Rollup ${path} has more than ${MAX_PAGES} pages.`);
  }
}

/**
 * The API's CivilDate wrapper: `{ date: { year, month, day } }`. The extra
 * `date` nesting is required — a bare `{year, month, day}` is rejected.
 */
export function civilDate(date: string): { date: { year: number; month: number; day: number } } {
  const parts = date.split('-');
  return {
    date: { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) },
  };
}

/** Shift a `YYYY-MM-DD` string by whole days, staying in UTC to avoid DST drift. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The live API caps rollup ranges per data type: 14 days for the
 * high-resolution set, 90 days for everything else.
 */
const SHORT_ROLLUP_RANGE_TYPES = new Set([
  'heart-rate',
  'active-minutes',
  'total-calories',
  'calories-in-heart-rate-zone',
]);

export function rollupRangeCapDays(dataType: string): number {
  return SHORT_ROLLUP_RANGE_TYPES.has(dataType) ? 14 : 90;
}

/** `list` pageSize ceiling: 25 for sleep/exercise, 10000 for everything else. */
const SMALL_PAGE_CAP_TYPES = new Set(['sleep', 'exercise']);

export function maxPageSize(dataType: string): number {
  return SMALL_PAGE_CAP_TYPES.has(dataType) ? 25 : 10000;
}
