import { z } from 'zod';
import type { Env } from '../../env';
import { GoogleAuthError } from '../../lib/errors';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * KV keys are namespaced with a `google_` prefix so a half-migrated
 * deployment can keep its legacy Fitbit tokens in the same TOKENS
 * namespace without the two clobbering each other.
 */
export const KV_ACCESS_TOKEN = 'google_access_token';
export const KV_REFRESH_TOKEN = 'google_refresh_token';
export const KV_EXPIRES_AT = 'google_expires_at';

/**
 * Google's refresh response omits `refresh_token` — unlike Fitbit, the
 * refresh token is long-lived and is NOT rotated on use. `scope` is also
 * omitted on some refreshes, so both are optional here.
 */
const RefreshResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
});
type RefreshResponseT = z.infer<typeof RefreshResponse>;

const REFRESH_SKEW_SEC = 120;

/** Only what the token store needs, so several workers could share one store. */
export type TokenEnv = Pick<Env, 'TOKENS' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>;

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

async function readStoredTokens(env: TokenEnv): Promise<TokenBundle> {
  const [accessToken, refreshToken, expiresAtRaw] = await Promise.all([
    env.TOKENS.get(KV_ACCESS_TOKEN),
    env.TOKENS.get(KV_REFRESH_TOKEN),
    env.TOKENS.get(KV_EXPIRES_AT),
  ]);

  // The refresh token is the only value we cannot rebuild ourselves.
  if (!refreshToken) {
    throw new GoogleAuthError(
      `No Google refresh token in the TOKENS KV namespace (key: ${KV_REFRESH_TOKEN}). ` +
        'Run `pnpm run setup:google` on a developer machine, then push the printed ' +
        '`wrangler kv key put --remote` commands.',
    );
  }

  const expiresAt = Number(expiresAtRaw ?? 0);
  return {
    accessToken: accessToken ?? '',
    // An unparseable expiry is treated as "expired" rather than fatal: the
    // refresh path below can always rebuild a valid access token.
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    refreshToken,
  };
}

async function persistTokens(
  env: TokenEnv,
  tokens: RefreshResponseT,
  previousRefreshToken: string,
  issuedAtSec: number,
): Promise<void> {
  const expiresAt = issuedAtSec + tokens.expires_in;
  await Promise.all([
    env.TOKENS.put(KV_ACCESS_TOKEN, tokens.access_token),
    env.TOKENS.put(KV_EXPIRES_AT, String(expiresAt)),
    // Google normally omits refresh_token on refresh; only overwrite when it
    // actually rotates one in, so we never blank out a working credential.
    tokens.refresh_token && tokens.refresh_token !== previousRefreshToken
      ? env.TOKENS.put(KV_REFRESH_TOKEN, tokens.refresh_token)
      : Promise.resolve(),
  ]);
}

export async function refreshTokens(env: TokenEnv, refreshToken: string): Promise<TokenBundle> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleAuthError(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. ' +
        'Run `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();

  if (!res.ok) {
    // `invalid_grant` is the one failure a redeploy cannot fix, so name the
    // two causes that actually produce it in a single-user deployment.
    const isInvalidGrant = text.includes('invalid_grant');
    throw new GoogleAuthError(
      `Google token refresh failed: HTTP ${res.status} ${res.statusText} — ${text}` +
        (isInvalidGrant
          ? '\n\nThe refresh token is no longer valid. The usual causes are (a) the OAuth ' +
            'consent screen is still in "Testing", where refresh tokens expire after 7 days — ' +
            'publish it to "In production"; or (b) access was revoked at ' +
            'https://myaccount.google.com/permissions. Re-run `pnpm run setup:google` either way.'
          : ''),
    );
  }

  let parsed: RefreshResponseT;
  try {
    parsed = RefreshResponse.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Do not include the body: it may hold a fresh access_token, and this
    // message can reach the Claude chat through the tool error result.
    throw new GoogleAuthError(`Google token refresh returned an unexpected payload (${reason})`);
  }

  const issuedAtSec = Math.floor(Date.now() / 1000);
  await persistTokens(env, parsed, refreshToken, issuedAtSec);

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? refreshToken,
    expiresAt: issuedAtSec + parsed.expires_in,
  };
}

/**
 * Returns a currently-valid access token, refreshing when within
 * REFRESH_SKEW_SEC of expiry. Safe to call on every request.
 *
 * Google access tokens live ~1 hour (vs Fitbit's 8), so this refreshes far
 * more often. Concurrent refreshes are harmless: Google accepts the same
 * refresh token repeatedly and simply mints a second access token, and both
 * remain valid, so no KV-CAS lock is needed.
 */
export async function getAccessToken(env: TokenEnv): Promise<string> {
  const current = await readStoredTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (current.accessToken && current.expiresAt - REFRESH_SKEW_SEC > now) {
    return current.accessToken;
  }
  const refreshed = await refreshTokens(env, current.refreshToken);
  return refreshed.accessToken;
}

/** Force the next `getAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateAccessToken(env: TokenEnv): Promise<void> {
  await env.TOKENS.put(KV_EXPIRES_AT, '0');
}
