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
  }
  return {
    content: [{ type: 'text', text: `Error: ${message}${hint}` }],
    isError: true,
  };
}
