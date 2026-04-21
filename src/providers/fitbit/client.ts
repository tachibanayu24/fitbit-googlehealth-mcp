import type { ZodType } from 'zod';
import type { Env } from '../../env';
import { FitbitApiError, FitbitRateLimitError } from '../../lib/errors';
import { parseRetryAfter, sleep } from '../../lib/rate-limit';
import { getAccessToken, invalidateAccessToken } from './oauth';

const FITBIT_API_BASE = 'https://api.fitbit.com';

export type FitbitRequest = {
  /** Absolute path starting with `/`, e.g. `/1/user/-/profile.json`. */
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | undefined>;
  /** Form body for writes; becomes `application/x-www-form-urlencoded`. */
  form?: Record<string, string | number | undefined>;
};

export class FitbitClient {
  constructor(private readonly env: Env) {}

  async requestJson<T>(schema: ZodType<T>, req: FitbitRequest): Promise<T> {
    const body = await this.requestText(req);
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      // Include a slice of the raw body so future schema mismatches are
      // diagnosable from the MCP tool error alone (wrangler tail doesn't
      // surface console logs from inside the Worker in pretty mode).
      const rawPreview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      throw new FitbitApiError(
        200,
        `Schema validation failed at ${req.path}: ${parsed.error.message}\nRaw body preview: ${rawPreview}`,
        req.path,
      );
    }
    return parsed.data;
  }

  async requestText(req: FitbitRequest): Promise<string> {
    const url = new URL(req.path, FITBIT_API_BASE);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 3; // original + one refresh retry + one rate-limit retry
    while (true) {
      attempt++;
      const token = await getAccessToken(this.env);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      let body: BodyInit | undefined;
      if (req.form) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(req.form)) {
          if (v !== undefined && v !== null && v !== '') {
            form.set(k, String(v));
          }
        }
        body = form;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const t0 = Date.now();
      const res = await fetch(url, { method: req.method ?? 'GET', headers, body });
      const ms = Date.now() - t0;
      const method = req.method ?? 'GET';
      // DIAGNOSTIC (temporary): attach timing + status per attempt so we
      // can tell whether long responses are from Fitbit itself, a 401
      // refresh loop, or a 429 Retry-After sleep.
      console.log(`[fitbit] ${method} ${req.path} → ${res.status} ${ms}ms attempt=${attempt}`);

      if (res.status === 401 && attempt === 1) {
        // token was rejected — force refresh and try once
        await invalidateAccessToken(this.env);
        continue;
      }

      if (res.status === 429) {
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'));
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[fitbit] 429 sleeping ${waitSec}s before retry`);
          await sleep(waitSec * 1000);
          continue;
        }
        throw new FitbitRateLimitError(waitSec, req.path);
      }

      const text = await res.text();
      if (!res.ok) {
        console.log(`[fitbit] non-ok body: ${text.slice(0, 300)}`);
        throw new FitbitApiError(res.status, text, req.path);
      }
      return text;
    }
  }
}
