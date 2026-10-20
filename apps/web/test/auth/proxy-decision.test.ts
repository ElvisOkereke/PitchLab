import { describe, expect, it } from 'vitest';
import { proxyDecision } from '@/lib/auth/proxy-decision';

describe('proxyDecision', () => {
  it('proxyDecision redirects every protected path with next=', () => {
    for (const p of ['/', '/leaderboard', '/command', '/runs', '/settings', '/cases/x', '/cases/x/export.md']) {
      expect(proxyDecision(p, false)).toEqual({ type: 'redirect', to: `/login?next=${encodeURIComponent(p)}` });
    }
    expect(proxyDecision('/login', false)).toEqual({ type: 'next' });
  });

  it('keeps the query string in next= and treats /login with a query as public', () => {
    expect(proxyDecision('/cases/x?tab=score', false)).toEqual({ type: 'redirect', to: '/login?next=%2Fcases%2Fx%3Ftab%3Dscore' });
    expect(proxyDecision('/login?next=%2Fruns', false)).toEqual({ type: 'next' });
  });

  it('lets an owner through and sends an authed /login visit home', () => {
    for (const p of ['/', '/cases/x', '/runs?page=2']) expect(proxyDecision(p, true)).toEqual({ type: 'next' });
    expect(proxyDecision('/login', true)).toEqual({ type: 'redirect', to: '/' });
  });

  it('lets static assets through and guards look-alikes', () => {
    for (const p of ['/_next/static/chunks/a.js', '/_next/image?url=x', '/favicon.ico']) expect(proxyDecision(p, false)).toEqual({ type: 'next' });
    for (const p of ['/login-x', '/loginx', '/login/../runs', '/_next/data/x', '/favicon.ico.evil']) {
      expect(proxyDecision(p, false).type).toBe('redirect');
    }
  });
});
