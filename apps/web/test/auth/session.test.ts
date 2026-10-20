import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { SESSION_TTL_S, sessionCookieName, sessionCookieOptions, signSession, verifySession } from '@/lib/auth/session';

const secret = 's'.repeat(40);
const key = new TextEncoder().encode(secret);

describe('session tokens', () => {
  it('a fresh token verifies as the owner and expires in 7 days', async () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const token = await signSession(secret, now);
    const s = await verifySession(token, secret, now);
    expect(s).toEqual({ sub: 'owner', exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_S });
    expect(SESSION_TTL_S).toBe(604_800);
  });

  it('every sign issues a different token (fresh token per login)', async () => {
    const now = new Date();
    expect(await signSession(secret, now)).not.toBe(await signSession(secret, now));
  });

  it('session rejects other secret, alg none, expired, tampered and wrong sub', async () => {
    const good = await signSession(secret);
    expect(await verifySession(good, 'o'.repeat(40))).toBeNull();

    const none = new UnsecuredJWT({}).setSubject('owner').setIssuedAt().setExpirationTime('7d').encode();
    expect(await verifySession(none, secret)).toBeNull();

    const old = await signSession(secret, new Date(Date.now() - 8 * 86_400_000));
    expect(await verifySession(old, secret)).toBeNull();

    const [h, , sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'owner', exp: 9_999_999_999, iat: 1 })).toString('base64url');
    expect(await verifySession(`${h}.${forged}.${sig}`, secret)).toBeNull();

    const admin = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuedAt().setExpirationTime('7d').sign(key);
    expect(await verifySession(admin, secret)).toBeNull();

    const hs512 = await new SignJWT({}).setProtectedHeader({ alg: 'HS512' }).setSubject('owner').setIssuedAt().setExpirationTime('7d')
      .sign(new TextEncoder().encode(secret.repeat(2)));
    expect(await verifySession(hs512, secret.repeat(2))).toBeNull();

    const noExp = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('owner').setIssuedAt().sign(key);
    expect(await verifySession(noExp, secret)).toBeNull();

    for (const junk of [undefined, '', 'a.b.c', 'not-a-jwt']) expect(await verifySession(junk, secret)).toBeNull();
  });

  it('cookie options are HttpOnly, SameSite=Lax, 7 days, Secure only when asked', () => {
    expect(sessionCookieOptions(false)).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 604_800 });
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 604_800 });
    expect(sessionCookieName(true)).toBe('__Host-bcg_session');
    expect(sessionCookieName(false)).toBe('bcg_session');
  });
});
