import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { buildReport, peekReport } from '../insights/report';
import { assertIsoDate, setTimeZone } from '../lib/date';
import appHtml from './app.html';
import {
  createSession,
  passwordMatches,
  recordFailure,
  SESSION_COOKIE,
  SESSION_DAYS,
  tooManyFailures,
  verifySession,
} from './auth';
import { BARLOW_600, BARLOW_700 } from './fonts';
import { ICON_180, ICON_512 } from './icons';
import { loginPage } from './login';

type App = { Bindings: Env };

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

const manifest = {
  name: 'Health MCP',
  short_name: 'Health MCP',
  start_url: '/app',
  scope: '/app',
  display: 'standalone',
  background_color: '#101518',
  theme_color: '#283339',
  icons: [
    { src: '/app/icon-180.png', sizes: '180x180', type: 'image/png' },
    { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

function asset(base64: string, type: string, maxAge: number): Response {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}` },
  });
}
const png = (base64: string) => asset(base64, 'image/png', 604_800);
const font = (base64: string) => asset(base64, 'font/woff2', 31_536_000);

const signedIn = (c: Context<App>) =>
  verifySession(c.env.DASHBOARD_PASSWORD, getCookie(c, SESSION_COOKIE));

export const dashboard = new Hono<App>();

dashboard.get('/', async (c) => {
  if (!(await signedIn(c))) return c.html(loginPage(), 200, NO_STORE);
  return c.html(appHtml, 200, NO_STORE);
});

dashboard.post('/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (await tooManyFailures(c.env.CACHE, ip)) {
    return c.html(loginPage('Too many tries. Wait 15 minutes.'), 429, NO_STORE);
  }
  const form = await c.req.parseBody();
  if (!passwordMatches(c.env.DASHBOARD_PASSWORD, String(form.password ?? ''))) {
    await recordFailure(c.env.CACHE, ip);
    return c.html(loginPage('Wrong password.'), 401, NO_STORE);
  }
  setCookie(c, SESSION_COOKIE, await createSession(c.env.DASHBOARD_PASSWORD as string), {
    path: '/app',
    httpOnly: true,
    secure: true,
    // Lax, because Strict drops the session when the page is opened from a link in another app.
    sameSite: 'Lax',
    maxAge: SESSION_DAYS * 86_400,
  });
  return c.redirect('/app', 303);
});

dashboard.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/app', secure: true });
  return c.redirect('/app', 303);
});

dashboard.get('/api/report', async (c) => {
  if (!(await signedIn(c))) return c.json({ error: 'signed_out' }, 401, NO_STORE);
  setTimeZone(c.env.TIMEZONE);
  const date = c.req.query('date') || undefined;
  if (date) assertIsoDate(date);
  const days = Number(c.req.query('days') ?? 30);
  try {
    if (c.req.query('peek') === '1') {
      const saved = await peekReport(c.env, { date, days });
      return saved ? c.json(saved, 200, NO_STORE) : c.body(null, 204, NO_STORE);
    }
    const keepAlive = (job: Promise<unknown>) => c.executionCtx.waitUntil(job);
    const fresh = c.req.query('fresh') === '1';
    return c.json(await buildReport(c.env, { date, days, fresh, keepAlive }), 200, NO_STORE);
  } catch (err) {
    console.log('[dashboard] report failed', err instanceof Error ? err.message : err);
    return c.json({ error: 'report_failed' }, 502, NO_STORE);
  }
});

dashboard.get('/manifest.webmanifest', (c) =>
  c.body(JSON.stringify(manifest), 200, { 'Content-Type': 'application/manifest+json' }),
);
dashboard.get('/icon-180.png', () => png(ICON_180));
dashboard.get('/icon-512.png', () => png(ICON_512));
dashboard.get('/font/barlow-600.woff2', () => font(BARLOW_600));
dashboard.get('/font/barlow-700.woff2', () => font(BARLOW_700));
