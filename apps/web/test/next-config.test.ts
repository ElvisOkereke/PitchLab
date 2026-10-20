import { describe, expect, it } from 'vitest';
import { securityHeaders } from '@/lib/security-headers';
import nextConfig from '../next.config';

const asMap = (h: { key: string; value: string }[]) => Object.fromEntries(h.map((x) => [x.key, x.value]));

describe('security headers', () => {
  const base = {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
  };

  it('sends HSTS only in production (D2-R5 item 6)', () => {
    expect(asMap(securityHeaders(false))).toEqual(base);
    expect(asMap(securityHeaders(true))).toEqual({ ...base, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' });
  });

  it('next.config applies them to every route', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    expect(asMap(rules[0]!.headers)).toMatchObject(base);
  });
});

describe('next.config', () => {
  it('disables the image optimizer (no /_next/image endpoint, no sharp) (D2-R5 item 4)', () => {
    expect(nextConfig.images).toEqual({ unoptimized: true });
  });

  it('hides the powered-by header and transpiles core', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.transpilePackages).toEqual(['@bcg/core']);
  });
});
