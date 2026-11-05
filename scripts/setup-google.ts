#!/usr/bin/env tsx
/**
 * One-shot Google Health OAuth bootstrap CLI.
 *
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   pnpm run setup:google            # read-only scopes
 *   pnpm run setup:google -- --write # also request write scopes
 *   pnpm run setup:google -- --write-activity # only the activity write scope
 *
 * Starts a localhost callback server, walks the Authorization Code + PKCE flow
 * in the system browser, exchanges the code for tokens, and writes them
 * straight into the TOKENS Workers KV namespace with `wrangler`. The tokens
 * are never printed, so they do not end up in shell history or scrollback.
 *
 * Needs a configured wrangler.toml (TOKENS namespace id) and `wrangler login`.
 *
 * The Worker never runs this path. Google blocks OAuth inside embedded
 * WebViews (`disallowed_useragent`), which is exactly what Claude mobile would
 * use, so consent is collected once here in a real browser instead.
 */

import { exec, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { envPath, loadEnv } from './load-env';

loadEnv();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8788;
const CALLBACK_PATH = '/google/callback';

/**
 * Read scopes for every category this server touches. This is the default:
 * without write scopes Google itself rejects every write and delete, even if
 * the connector URL leaks.
 *
 * Google splits read and write into separate scopes; a `.writeonly` scope does
 * NOT imply read. `settings.readonly` is what backs `list_devices` and the
 * unit/timezone fields of `get_profile`.
 */
const READ_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];

/** Added only with `--write`. Pair with ENABLE_WRITE_TOOLS = "true" in wrangler.toml. */
const WRITE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.writeonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly',
];

/** Added only with `--location`. Needed only by `export_exercise_tcx` (GPS routes). */
const LOCATION_SCOPES = ['https://www.googleapis.com/auth/googlehealth.location.readonly'];

/** Added only with `--write-activity`. Pair with ENABLE_WRITE_TOOLS = "activity". */
const ACTIVITY_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly',
];

const WITH_WRITE = process.argv.includes('--write');
const WITH_ACTIVITY_WRITE = !WITH_WRITE && process.argv.includes('--write-activity');
const WITH_LOCATION = process.argv.includes('--location');
const SCOPES = [
  ...READ_SCOPES,
  ...(WITH_WRITE ? WRITE_SCOPES : []),
  ...(WITH_ACTIVITY_WRITE ? ACTIVITY_WRITE_SCOPES : []),
  ...(WITH_LOCATION ? LOCATION_SCOPES : []),
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = path.join(REPO_ROOT, 'wrangler.toml');

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open '${url}'`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(cmd, () => {
    // Best effort — the URL is printed too, so a failure here is not fatal.
  });
}

function waitForCallback(opts: { expectedState: string }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Google authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Google OAuth error: ${error} ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 24px}</style></head>
<body>
<h1>&#10003; Authorized</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`);
      server.close();
      resolve({ code });
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponseT> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }

  const json = JSON.parse(text);
  if (!json.refresh_token) {
    throw new Error(
      'Google returned no refresh_token.\n\n' +
        'This happens when the account has already granted this client and Google ' +
        'suppresses the repeat consent. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run this again.',
    );
  }
  return TokenResponse.parse(json);
}

/** Runs wrangler without a shell and with its output captured, not shown. */
function wrangler(args: string[]): void {
  execFileSync('pnpm', ['wrangler', ...args, '--config', WRANGLER_TOML], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Writes one key into the remote TOKENS namespace. The value goes through a
 * 0600 temp file (`--path`), so it is not visible in the process list and
 * wrangler does not echo it.
 */
function putTokenKv(key: string, value: string): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-google-'));
  const file = path.join(dir, 'value');
  try {
    writeFileSync(file, value, { mode: 0o600 });
    wrangler(['kv', 'key', 'put', '--remote', '--binding=TOKENS', key, '--path', file]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(`wrangler kv key put ${key} failed:\n${raw.replaceAll(value, mask(value))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fails before the OAuth flow, so a broken setup does not waste a consent.
 * Listing the TOKENS namespace checks the login, the namespace id in
 * wrangler.toml and the account selection in one call.
 */
function assertWranglerReady(): void {
  if (!existsSync(WRANGLER_TOML)) {
    console.error('Error: wrangler.toml not found.');
    console.error('  cp wrangler.toml.example wrangler.toml');
    console.error('  pnpm wrangler kv namespace create TOKENS   # paste the id into wrangler.toml');
    console.error('  pnpm wrangler kv namespace create CACHE    # paste the id into wrangler.toml');
    process.exit(1);
  }
  try {
    wrangler(['kv', 'key', 'list', '--remote', '--binding=TOKENS']);
  } catch (err) {
    console.error('Error: cannot reach the TOKENS KV namespace with wrangler.');
    console.error('  Check `pnpm wrangler login` and the TOKENS id in wrangler.toml.');
    console.error(
      '  If your Cloudflare login has several accounts, set account_id in wrangler.toml.',
    );
    console.error('');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function printSetupHelp(): void {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.');
  console.error('');
  console.error('  Easiest: copy .env.example to .env and paste your credentials in.');
  console.error(`  Expected at: ${envPath}`);
  console.error('');
  console.error('      cp .env.example .env      # macOS / Linux / Git Bash');
  console.error('      copy .env.example .env    # Windows cmd / PowerShell');
  console.error('');
  console.error('  .env is gitignored and is only read by these local scripts.');
  console.error('');
  console.error('  To get those credentials:');
  console.error('  1. Create/select a Google Cloud project:');
  console.error('     https://console.cloud.google.com/projectcreate');
  console.error('  2. Enable the Google Health API:');
  console.error('     https://console.cloud.google.com/apis/api/health.googleapis.com');
  console.error('  3. Configure the OAuth consent screen (External) and PUBLISH it:');
  console.error('     https://console.cloud.google.com/auth/audience');
  console.error('     Publishing status must be "In production", or refresh tokens');
  console.error('     expire after 7 days and the Worker breaks every week.');
  console.error('  4. Create an OAuth client ID, application type "Desktop app":');
  console.error('     https://console.cloud.google.com/apis/credentials');
  console.error('  5. Put them in .env and run this again:');
  console.error('     pnpm run setup:google');
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    printSetupHelp();
    process.exit(1);
  }
  assertWranglerReady();

  const state = base64url(randomBytes(16));
  const { verifier, challenge } = generatePkce();
  const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // Both are required to be handed a refresh_token at all.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  if (process.env.GOOGLE_LOGIN_HINT)
    authUrl.searchParams.set('login_hint', process.env.GOOGLE_LOGIN_HINT);

  console.log('');
  console.log('Google Health OAuth bootstrap');
  console.log('─────────────────────────────');
  console.log('');
  console.log('Redirect URI (Desktop-app clients accept any loopback port):');
  console.log(`  ${redirectUri}`);
  console.log('');
  console.log('Requesting scopes:');
  for (const s of SCOPES) console.log(`  · ${s.split('googlehealth.')[1] ?? s}`);
  console.log('');
  console.log('Opening the authorization URL in your default browser…');
  console.log('(If it does not open, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for the callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
  console.log('');

  openInBrowser(authUrl.toString());

  const { code } = await waitForCallback({ expectedState: state });
  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

  console.log('✓ Got tokens');
  console.log('');
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(tokens.refresh_token)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s (unix epoch: ${expiresAt})`);
  if (tokens.scope) {
    console.log('  granted scopes:');
    for (const s of tokens.scope.split(' ')) {
      console.log(`    · ${s.split('googlehealth.')[1] ?? s}`);
    }
  }
  console.log('');
  console.log('Writing tokens to the TOKENS KV namespace…');
  putTokenKv('google_refresh_token', tokens.refresh_token);
  putTokenKv('google_access_token', tokens.access_token);
  putTokenKv('google_expires_at', String(expiresAt));
  console.log('✓ Tokens stored in Workers KV (not printed).');
  console.log('');
  console.log('Next:');
  console.log('  1) Verify the token reads your data (the token is not echoed):');
  console.log(
    '     GOOGLE_ACCESS_TOKEN=$(pnpm -s wrangler kv key get --remote --binding=TOKENS google_access_token) pnpm run probe:google',
  );
  console.log('  2) Deploy: pnpm deploy');
  if (WITH_WRITE) {
    console.log('');
    console.log('  Write scopes granted. Set ENABLE_WRITE_TOOLS = "true" in wrangler.toml');
    console.log('  to expose the write/delete tools, then deploy.');
  }
  if (WITH_ACTIVITY_WRITE) {
    console.log('');
    console.log('  Activity write scope granted. Set ENABLE_WRITE_TOOLS = "activity" in');
    console.log('  wrangler.toml to expose log_workout and delete_workout, then deploy.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
