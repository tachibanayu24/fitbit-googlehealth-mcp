import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export type GuardInput = {
  secretFromPath: string | undefined;
  expectedSecret: string | undefined;
  clientIp: string | undefined;
  allowedCidrs: string | undefined;
};

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: GuardDenyReason };

export type GuardDenyReason =
  | 'missing_secret'
  | 'secret_mismatch'
  | 'missing_client_ip'
  | 'no_cidr_configured'
  | 'ip_not_allowed';

export function verifyAccess(input: GuardInput): GuardResult {
  if (!input.expectedSecret || !input.secretFromPath) {
    return { ok: false, status: 401, reason: 'missing_secret' };
  }
  if (!timingSafeEqual(input.secretFromPath, input.expectedSecret)) {
    return { ok: false, status: 401, reason: 'secret_mismatch' };
  }

  if (!input.clientIp) {
    return { ok: false, status: 403, reason: 'missing_client_ip' };
  }

  const cidrs = parseCidrList(input.allowedCidrs);
  if (cidrs.length === 0) {
    return { ok: false, status: 403, reason: 'no_cidr_configured' };
  }
  if (!cidrs.some((cidr) => isIpv4InCidr(input.clientIp ?? '', cidr))) {
    return { ok: false, status: 403, reason: 'ip_not_allowed' };
  }

  return { ok: true };
}

export function parseCidrList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  return result >>> 0;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return false;
  const range = cidr.slice(0, slashIdx);
  const bitsStr = cidr.slice(slashIdx + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

export const guardMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const result = verifyAccess({
      secretFromPath: c.req.param('secret'),
      expectedSecret: c.env.MCP_SHARED_SECRET,
      clientIp: c.req.header('CF-Connecting-IP') ?? undefined,
      allowedCidrs: c.env.ALLOWED_CIDRS,
    });
    if (!result.ok) {
      return c.text(result.reason, result.status);
    }
    await next();
  };
};
