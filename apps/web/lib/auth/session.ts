import 'server-only';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/** 7 days. No sliding refresh: the owner logs in again weekly. Rotating SESSION_SECRET logs out every device. */
export const SESSION_TTL_S = 604_800;

/** `__Host-` (Secure, Path=/, no Domain) when the cookie is Secure; browsers reject that prefix over plain http. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-bcg_session' : 'bcg_session';
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: SESSION_TTL_S };
}

const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** A fresh HS256 token for the owner (a random jti, so every login issues a different token). */
export async function signSession(secret: string, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('owner')
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_S)
    .setJti(randomUUID())
    .sign(keyOf(secret));
}

/** The session when `token` is an unexpired HS256 token for the owner signed with `secret`, else null. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now?: Date,
): Promise<{ sub: 'owner'; exp: number } | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: ['HS256'],
      subject: 'owner',
      requiredClaims: ['exp', 'iat', 'sub'],
      ...(now ? { currentDate: now } : {}),
    });
    if (payload.sub !== 'owner' || typeof payload.exp !== 'number') return null;
    return { sub: 'owner', exp: payload.exp };
  } catch {
    return null;
  }
}
