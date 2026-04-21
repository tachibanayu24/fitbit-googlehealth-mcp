import { describe, expect, it } from 'vitest';
import {
  ipv4ToInt,
  isIpv4InCidr,
  parseCidrList,
  timingSafeEqual,
  verifyAccess,
} from '../../src/auth/guard';

describe('ipv4ToInt', () => {
  it('converts known IPv4 addresses', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToInt('160.79.104.0')).toBe(0xa04f6800);
    expect(ipv4ToInt('160.79.111.255')).toBe(0xa04f6fff);
    expect(ipv4ToInt('1.2.3.4')).toBe(0x01020304);
  });

  it('rejects malformed addresses', () => {
    expect(ipv4ToInt('')).toBeNull();
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('1.2.3.4.5')).toBeNull();
    expect(ipv4ToInt('256.0.0.0')).toBeNull();
    expect(ipv4ToInt('-1.0.0.0')).toBeNull();
    expect(ipv4ToInt('a.b.c.d')).toBeNull();
    expect(ipv4ToInt('1.2.3.04')).toBe(0x01020304); // leading zero tolerated as plain digits
    expect(ipv4ToInt('1.2.3.')).toBeNull();
    expect(ipv4ToInt('2001:db8::1')).toBeNull();
  });
});

describe('isIpv4InCidr', () => {
  it('matches addresses inside the Anthropic CIDR', () => {
    expect(isIpv4InCidr('160.79.104.0', '160.79.104.0/21')).toBe(true);
    expect(isIpv4InCidr('160.79.105.42', '160.79.104.0/21')).toBe(true);
    expect(isIpv4InCidr('160.79.111.255', '160.79.104.0/21')).toBe(true);
  });

  it('rejects addresses outside the Anthropic CIDR', () => {
    expect(isIpv4InCidr('160.79.103.255', '160.79.104.0/21')).toBe(false);
    expect(isIpv4InCidr('160.79.112.0', '160.79.104.0/21')).toBe(false);
    expect(isIpv4InCidr('1.2.3.4', '160.79.104.0/21')).toBe(false);
  });

  it('handles /32 and /0', () => {
    expect(isIpv4InCidr('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(isIpv4InCidr('1.2.3.5', '1.2.3.4/32')).toBe(false);
    expect(isIpv4InCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(isIpv4InCidr('255.255.255.255', '0.0.0.0/0')).toBe(true);
  });

  it('rejects malformed CIDRs', () => {
    expect(isIpv4InCidr('1.2.3.4', '1.2.3.4')).toBe(false);
    expect(isIpv4InCidr('1.2.3.4', '1.2.3.4/33')).toBe(false);
    expect(isIpv4InCidr('1.2.3.4', '1.2.3.4/-1')).toBe(false);
    expect(isIpv4InCidr('1.2.3.4', '256.0.0.0/8')).toBe(false);
  });
});

describe('parseCidrList', () => {
  it('splits comma-separated values and trims whitespace', () => {
    expect(parseCidrList('160.79.104.0/21')).toEqual(['160.79.104.0/21']);
    expect(parseCidrList('160.79.104.0/21,10.0.0.0/8')).toEqual(['160.79.104.0/21', '10.0.0.0/8']);
    expect(parseCidrList(' 160.79.104.0/21 , 10.0.0.0/8 ')).toEqual([
      '160.79.104.0/21',
      '10.0.0.0/8',
    ]);
    expect(parseCidrList('')).toEqual([]);
    expect(parseCidrList(undefined)).toEqual([]);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });
});

describe('verifyAccess', () => {
  const anthropicCidr = '160.79.104.0/21';
  const secret = 'correct-horse-battery-staple';

  it('accepts a request with matching secret and allowed IP', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: secret,
        clientIp: '160.79.105.42',
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects when expectedSecret is not configured', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: undefined,
        clientIp: '160.79.105.42',
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: false, status: 401, reason: 'missing_secret' });
  });

  it('rejects when secretFromPath is missing', () => {
    expect(
      verifyAccess({
        secretFromPath: undefined,
        expectedSecret: secret,
        clientIp: '160.79.105.42',
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: false, status: 401, reason: 'missing_secret' });
  });

  it('rejects on secret mismatch (constant time)', () => {
    expect(
      verifyAccess({
        secretFromPath: 'wrong',
        expectedSecret: secret,
        clientIp: '160.79.105.42',
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: false, status: 401, reason: 'secret_mismatch' });
  });

  it('rejects when CF-Connecting-IP is missing even with correct secret', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: secret,
        clientIp: undefined,
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: false, status: 403, reason: 'missing_client_ip' });
  });

  it('rejects when ALLOWED_CIDRS is empty/unset', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: secret,
        clientIp: '160.79.105.42',
        allowedCidrs: '',
      }),
    ).toEqual({ ok: false, status: 403, reason: 'no_cidr_configured' });
  });

  it('rejects IP outside the allowed CIDR', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: secret,
        clientIp: '1.2.3.4',
        allowedCidrs: anthropicCidr,
      }),
    ).toEqual({ ok: false, status: 403, reason: 'ip_not_allowed' });
  });

  it('accepts IP matching any of the configured CIDRs', () => {
    expect(
      verifyAccess({
        secretFromPath: secret,
        expectedSecret: secret,
        clientIp: '10.20.30.40',
        allowedCidrs: `${anthropicCidr}, 10.0.0.0/8`,
      }),
    ).toEqual({ ok: true });
  });
});
