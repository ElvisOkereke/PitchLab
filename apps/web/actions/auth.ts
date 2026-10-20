'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { clientKey } from '@/lib/auth/client-ip';
import { verifyPassword } from '@/lib/auth/password';
import { createRateLimiter } from '@/lib/auth/rate-limit';
import { assertSameOrigin } from '@/lib/auth/require-owner';
import { safeNext } from '@/lib/auth/safe-next';
import { createSemaphore } from '@/lib/auth/semaphore';
import { sessionCookieName, sessionCookieOptions, signSession } from '@/lib/auth/session';
import { webEnv } from '@/lib/env';

export type LoginState = { error?: string };

// One limiter per server process (in memory; resets on restart).
const limiter = createRateLimiter();
// scrypt costs ~60 ms and 32 MiB: at most 2 verifications run at once and at most 10 wait; beyond that, refuse.
const verifySlots = createSemaphore(2, 10);

const LoginInputSchema = z.object({ password: z.string().min(1).max(1024) });

function tooMany(retryAfterS: number): LoginState {
  const minutes = Math.max(1, Math.ceil(retryAfterS / 60));
  return { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
}

async function checkPassword(password: string, stored: string): Promise<boolean | 'busy'> {
  const slot = verifySlots.acquire();
  if (!slot) return 'busy';
  const release = await slot;
  try {
    return await verifyPassword(password, stored);
  } finally {
    release();
  }
}

/**
 * Password login: origin check, then the rate limit, then the password. The attempt is counted (reserved) before the
 * slow password check, so parallel requests cannot all slip under the limit; a success releases it. Success sets a
 * fresh session cookie.
 */
export async function loginAction(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const env = webEnv();
  const h = await headers();
  assertSameOrigin(h);

  const key = clientKey(h, env.TRUST_PROXY_HOPS);
  const reservation = limiter.reserve(key);
  if (!reservation.allowed) return tooMany(reservation.retryAfterS);

  const input = LoginInputSchema.safeParse({ password: fd.get('password') });
  const ok = input.success ? await checkPassword(input.data.password, env.OWNER_PASSWORD_HASH) : false;
  // Refused for load: the reserved attempt stays counted (fail closed) and nothing was verified.
  if (ok === 'busy') return tooMany(60);
  if (!ok) {
    console.warn(`login failed (bucket ${key})`);
    return { error: 'Wrong password.' };
  }

  limiter.succeed(key, reservation.token!);
  const token = await signSession(env.SESSION_SECRET);
  (await cookies()).set(sessionCookieName(env.COOKIE_SECURE), token, sessionCookieOptions(env.COOKIE_SECURE));
  redirect(safeNext(fd.get('next')));
}

/** Expires the session cookie (Max-Age=0) and goes to /login. */
export async function logoutAction(): Promise<void> {
  const env = webEnv();
  assertSameOrigin(await headers());
  (await cookies()).set(sessionCookieName(env.COOKIE_SECURE), '', { ...sessionCookieOptions(env.COOKIE_SECURE), maxAge: 0 });
  redirect('/login');
}
