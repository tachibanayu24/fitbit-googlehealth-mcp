export type Env = {
  TOKENS: KVNamespace;
  CACHE: KVNamespace;

  /**
   * Which health backend to serve. Defaults to `google` when unset.
   *
   * `fitbit` targets the legacy Fitbit Web API (api.fitbit.com), which Google
   * is decommissioning in September 2026. It is kept only so an existing
   * deployment can fall back mid-migration; new deployments should use
   * `google`.
   */
  HEALTH_PROVIDER?: 'google' | 'fitbit';

  /** Google Health API (health.googleapis.com/v4) — the current backend. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  /** Legacy Fitbit Web API credentials. Only needed when HEALTH_PROVIDER=fitbit. */
  FITBIT_CLIENT_ID?: string;
  FITBIT_CLIENT_SECRET?: string;

  /**
   * IANA timezone used to resolve "today" for tools with an optional `date`.
   * Defaults to UTC when unset. Example: "Europe/London".
   */
  TIMEZONE?: string;

  /**
   * "true" exposes the write, delete and meal-preset tools. "activity" exposes only
   * log_workout and delete_workout. Any other value, or unset, serves read tools only.
   */
  ENABLE_WRITE_TOOLS?: string;

  MCP_SHARED_SECRET: string;
  GATEWAY_SHARED_SECRET?: string;
  ALLOWED_CIDRS: string;

  /**
   * Optional "YYYY-MM-DD". When set, the insights report shows the real and
   * body age. When unset, all age-based output is skipped.
   */
  BIRTH_DATE?: string;

  /**
   * Optional default wake-up alarm "HH:MM" (24 hour) used by the insights
   * sleep plan. Defaults to "07:00" when unset.
   */
  SLEEP_WAKE_TIME?: string;

  DATA_START?: string;
  DASHBOARD_PASSWORD?: string;
};
