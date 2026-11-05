import { timingSafeEqual } from '../auth/guard';

export const SESSION_COOKIE = 'session';
export const SESSION_DAYS = 180;
const MAX_FAILURES = 8;

const encoder = new TextEncoder();

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return btoa(String.fromCharCode(...sig))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createSession(secret: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${await sign(secret, `session:${expires}`)}`;
}

export async function verifySession(
  secret: string | undefined,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!secret || !token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < now) return false;
  return timingSafeEqual(sig, await sign(secret, `session:${expires}`));
}

export function passwordMatches(secret: string | undefined, given: string): boolean {
  return !!secret && timingSafeEqual(given, secret);
}

export async function tooManyFailures(kv: KVNamespace, ip: string): Promise<boolean> {
  return Number((await kv.get(`login_fail:${ip}`)) ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(kv: KVNamespace, ip: string): Promise<void> {
  const count = Number((await kv.get(`login_fail:${ip}`)) ?? 0) + 1;
  await kv.put(`login_fail:${ip}`, String(count), { expirationTtl: 900 });
}
