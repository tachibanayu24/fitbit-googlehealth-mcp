#!/usr/bin/env tsx
/**
 * One-shot Fitbit OAuth bootstrap CLI.
 *
 *   export FITBIT_CLIENT_ID=...
 *   export FITBIT_CLIENT_SECRET=...
 *   pnpm run setup:fitbit
 *
 * Starts a tiny localhost callback server, walks the user through the
 * Authorization Code + PKCE flow in their system browser, exchanges the
 * code for tokens, and prints the exact `wrangler` commands needed to
 * move those tokens into Workers KV / Secrets.
 *
 * The MCP Worker itself never runs this code path — Claude mobile /
 * claude.ai never sees the Fitbit OAuth screen. This avoids Google's
 * `disallowed_useragent` policy that blocks embedded WebViews.
 */

import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';

const FITBIT_AUTHORIZE_URL = 'https://www.fitbit.com/oauth2/authorize';
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 8787;
const CALLBACK_PATH = '/fitbit/callback';

const SCOPES = [
  'activity',
  'heartrate',
  'sleep',
  'nutrition',
  'profile',
  'weight',
  'respiratory_rate',
  'oxygen_saturation',
  'temperature',
  'cardio_fitness',
  'settings',
];

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.string(),
  user_id: z.string(),
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
  const platform = process.platform;
  const cmd =
    platform === 'darwin'
      ? `open '${url}'`
      : platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(cmd, (err) => {
    if (err) {
      // best effort; user can copy the URL from stdout
    }
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
        res.end(`<h1>Fitbit authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Fitbit OAuth error: ${error} ${desc}`));
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
<h1>✓ Authorized</h1>
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
  });

  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
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
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const json = JSON.parse(text);
  return TokenResponse.parse(json);
}

async function main(): Promise<void> {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Error: FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET must be set.');
    console.error('');
    console.error('  1. Create a Personal app at https://dev.fitbit.com/apps/new');
    console.error(`     Callback URL: http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`);
    console.error('  2. Export the values:');
    console.error('     export FITBIT_CLIENT_ID=...');
    console.error('     export FITBIT_CLIENT_SECRET=...');
    console.error('  3. Run again: pnpm run setup:fitbit');
    process.exit(1);
  }

  const state = base64url(randomBytes(16));
  const { verifier, challenge } = generatePkce();
  const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(FITBIT_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('');
  console.log('Fitbit OAuth bootstrap');
  console.log('──────────────────────');
  console.log('');
  console.log(`Callback URL (must match the dev.fitbit.com app settings):`);
  console.log(`  ${redirectUri}`);
  console.log('');
  console.log('Opening authorization URL in your default browser…');
  console.log('(If it does not open automatically, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
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
  console.log(`  user_id:       ${tokens.user_id}`);
  console.log(`  scope:         ${tokens.scope}`);
  console.log(`  token_type:    ${tokens.token_type}`);
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(tokens.refresh_token)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s (unix epoch: ${expiresAt})`);
  console.log('');
  console.log('Next: store these on Cloudflare Workers.');
  console.log('──────────────────────────────────────────');
  console.log('');
  console.log('1) One-time KV namespace creation (if not yet done):');
  console.log('   pnpm wrangler kv:namespace create TOKENS');
  console.log('   pnpm wrangler kv:namespace create CACHE');
  console.log('   # paste returned ids into wrangler.toml (uncomment the KV sections)');
  console.log('');
  console.log('2) Secrets:');
  console.log('   pnpm wrangler secret put FITBIT_CLIENT_ID');
  console.log(`     ↳ value: ${clientId}`);
  console.log('   pnpm wrangler secret put FITBIT_CLIENT_SECRET');
  console.log('     ↳ value: <your Fitbit app client secret>');
  console.log('   pnpm wrangler secret put MCP_SHARED_SECRET');
  console.log('     ↳ value: $(openssl rand -base64 32)');
  console.log('');
  console.log('3) Fitbit tokens into the TOKENS KV namespace:');
  console.log(
    `   pnpm wrangler kv:key put --binding=TOKENS refresh_token '${tokens.refresh_token}'`,
  );
  console.log(
    `   pnpm wrangler kv:key put --binding=TOKENS access_token  '${tokens.access_token}'`,
  );
  console.log(`   pnpm wrangler kv:key put --binding=TOKENS expires_at    '${expiresAt}'`);
  console.log(`   pnpm wrangler kv:key put --binding=TOKENS user_id       '${tokens.user_id}'`);
  console.log('');
  console.log('4) Deploy: pnpm deploy');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
