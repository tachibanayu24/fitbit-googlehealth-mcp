// ---------- Legacy Fitbit Web API ----------

export class FitbitAuthError extends Error {
  readonly code = 'fitbit_auth_error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'FitbitAuthError';
  }
}

export class FitbitApiError extends Error {
  readonly code = 'fitbit_api_error' as const;
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly endpoint?: string,
  ) {
    super(`Fitbit API ${status} at ${endpoint ?? '<unknown>'}: ${bodyText.slice(0, 240)}`);
    this.name = 'FitbitApiError';
  }
}

export class FitbitRateLimitError extends Error {
  readonly code = 'fitbit_rate_limit_error' as const;
  constructor(
    public readonly retryAfterSec: number,
    public readonly endpoint?: string,
  ) {
    super(
      `Fitbit rate limit exceeded at ${endpoint ?? '<unknown>'} (Retry-After: ${retryAfterSec}s)`,
    );
    this.name = 'FitbitRateLimitError';
  }
}

// ---------- Google Health API ----------

export class GoogleAuthError extends Error {
  readonly code = 'google_auth_error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export class GoogleApiError extends Error {
  readonly code = 'google_api_error' as const;
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly endpoint?: string,
  ) {
    super(`Google Health API ${status} at ${endpoint ?? '<unknown>'}: ${bodyText.slice(0, 240)}`);
    this.name = 'GoogleApiError';
  }
}

export class GoogleRateLimitError extends Error {
  readonly code = 'google_rate_limit_error' as const;
  constructor(
    public readonly retryAfterSec: number,
    public readonly endpoint?: string,
  ) {
    super(
      `Google Health API rate limit exceeded at ${endpoint ?? '<unknown>'} (retry after ${retryAfterSec}s)`,
    );
    this.name = 'GoogleRateLimitError';
  }
}

/**
 * Thrown when a tool maps to a capability the active provider does not have
 * (e.g. Fitbit-only intraday detail levels, or a Google Health data type that
 * is read-only). Carries a suggestion so the model can self-correct instead of
 * retrying the same call.
 */
export class UnsupportedOperationError extends Error {
  readonly code = 'unsupported_operation' as const;
  constructor(
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

// ---------- Tool result shaping ----------

export type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function toolErrorResult(err: unknown): ToolTextResult {
  const message = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (err instanceof FitbitAuthError) {
    hint =
      '\n\nHint: tokens may be missing or the refresh token is revoked. ' +
      'Re-run `pnpm run setup:fitbit` from a developer machine and repopulate the TOKENS KV namespace.';
  } else if (err instanceof FitbitRateLimitError) {
    hint = `\n\nHint: retry after ${err.retryAfterSec}s. Fitbit enforces 150 requests/hour/user.`;
  } else if (err instanceof GoogleAuthError) {
    hint =
      '\n\nHint: the Google refresh token is missing, expired, or revoked. ' +
      'Re-run `pnpm run setup:google` from a developer machine and repopulate the TOKENS KV namespace. ' +
      'If this recurs roughly every 7 days, the OAuth consent screen is still in "Testing" — ' +
      'publish it to "In production" at https://console.cloud.google.com/auth/audience.';
  } else if (err instanceof GoogleApiError && err.bodyText.includes('location_readonly')) {
    hint =
      '\n\nHint: TCX export needs the googlehealth.location.readonly scope. ' +
      'Re-run `pnpm run setup:google -- --location` from a developer machine.';
  } else if (err instanceof GoogleRateLimitError) {
    hint = `\n\nHint: retry after ${err.retryAfterSec}s.`;
  } else if (err instanceof UnsupportedOperationError && err.suggestion) {
    hint = `\n\nHint: ${err.suggestion}`;
  }
  return {
    content: [{ type: 'text', text: `Error: ${message}${hint}` }],
    isError: true,
  };
}
