import { describe, expect, it } from 'vitest';
import { isSameOrigin } from '@/lib/auth/origin';

const h = (o: Record<string, string>) => new Headers(o);

describe('isSameOrigin', () => {
  it('accepts the same host', () => {
    expect(isSameOrigin(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }), [])).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://App.Test', host: 'app.test' }), [])).toBe(true);
  });

  it('isSameOrigin rejects missing, null and foreign origins', () => {
    expect(isSameOrigin(h({ host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'null', host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'https://evil.com', host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'http://localhost:3001', host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'not a url', host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'javascript:alert(1)', host: 'localhost:3000' }), [])).toBe(false);
    expect(isSameOrigin(h({ origin: 'http://localhost:3000' }), [])).toBe(false);
  });

  it('uses the first x-forwarded-host value when present', () => {
    expect(isSameOrigin(h({ origin: 'https://app.test', 'x-forwarded-host': 'app.test, internal:8080', host: 'internal:8080' }), [])).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://evil.com', 'x-forwarded-host': 'app.test', host: 'evil.com' }), [])).toBe(false);
  });

  it('accepts ALLOWED_ORIGINS hosts (exact match, case-insensitive)', () => {
    const allowed = ['tunnel.example.com', 'https://other.test'];
    expect(isSameOrigin(h({ origin: 'https://tunnel.example.com', host: 'localhost:3000' }), allowed)).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://OTHER.test', host: 'localhost:3000' }), allowed)).toBe(true);
    expect(isSameOrigin(h({ origin: 'https://x.tunnel.example.com', host: 'localhost:3000' }), allowed)).toBe(false);
    expect(isSameOrigin(h({ host: 'localhost:3000' }), allowed)).toBe(false);
  });
});
