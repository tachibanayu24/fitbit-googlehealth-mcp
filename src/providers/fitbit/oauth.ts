import { z } from 'zod';
import type { Env } from '../../env';
import { FitbitAuthError } from '../../lib/errors';

const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.string(),
  user_id: z.string(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

const REFRESH_SKEW_SEC = 60;

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
  userId: string;
};

async function readStoredTokens(env: Env): Promise<TokenBundle> {
  const [accessToken, refreshToken, expiresAtRaw, userId] = await Promise.all([
    env.TOKENS.get('access_token'),
    env.TOKENS.get('refresh_token'),
    env.TOKENS.get('expires_at'),
    env.TOKENS.get('user_id'),
  ]);
  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new FitbitAuthError(
      'Fitbit tokens not found in TOKENS KV. Run `pnpm run setup:fitbit` on a developer machine and populate the namespace.',
    );
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new FitbitAuthError(`expires_at in KV is not numeric: ${expiresAtRaw}`);
  }
  return { accessToken, refreshToken, expiresAt, userId: userId ?? '' };
}

async function persistTokens(env: Env, tokens: TokenResponseT, issuedAtSec: number): Promise<void> {
  const expiresAt = issuedAtSec + tokens.expires_in;
  await Promise.all([
    env.TOKENS.put('access_token', tokens.access_token),
    env.TOKENS.put('refresh_token', tokens.refresh_token),
    env.TOKENS.put('expires_at', String(expiresAt)),
    env.TOKENS.put('user_id', tokens.user_id),
  ]);
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenBundle> {
  if (!env.FITBIT_CLIENT_ID || !env.FITBIT_CLIENT_SECRET) {
    throw new FitbitAuthError(
      'FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET not set. Run `wrangler secret put ...`.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const basic = btoa(`${env.FITBIT_CLIENT_ID}:${env.FITBIT_CLIENT_SECRET}`);

  const res = await fetch(FITBIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FitbitAuthError(
      `Token refresh failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }

  let parsed: TokenResponseT;
  try {
    parsed = TokenResponse.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FitbitAuthError(`Token refresh returned unexpected payload (${reason}): ${text}`);
  }

  const issuedAtSec = Math.floor(Date.now() / 1000);
  await persistTokens(env, parsed, issuedAtSec);

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: issuedAtSec + parsed.expires_in,
    userId: parsed.user_id,
  };
}

/**
 * Returns a currently-valid access token, refreshing it when within
 * REFRESH_SKEW_SEC of expiry. Safe to call on every Fitbit request.
 *
 * Concurrency note: two simultaneous refreshes with the same refresh_token
 * both succeed because Fitbit returns the same response for identical
 * refresh_token requests within a 2-minute window (see
 * https://dev.fitbit.com/build/reference/web-api/authorization/refresh-token/).
 * We rely on that instead of a KV-CAS lock for simplicity.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const current = await readStoredTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (current.expiresAt - REFRESH_SKEW_SEC > now) {
    return current.accessToken;
  }
  const refreshed = await refreshTokens(env, current.refreshToken);
  return refreshed.accessToken;
}

/** Force the next `getAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateAccessToken(env: Env): Promise<void> {
  await env.TOKENS.put('expires_at', '0');
}
