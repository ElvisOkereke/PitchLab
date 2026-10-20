'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { clientKey } from '@/lib/auth/client-ip';
import { verifyPassword } from '@/lib/auth/password';
import { createRateLimiter } from '@/lib/auth/rate-limit';
import { assertSameOrigin } from '@/lib/auth/require-owner';
import { safeNext } from '@/lib/auth/safe-next';
import { sessionCookieName, sessionCookieOptions, signSession } from '@/lib/auth/session';
import { webEnv } from '@/lib/env';

export type LoginState = { error?: string };

// One limiter per server process (in memory; resets on restart).
const limiter = createRateLimiter();

const LoginInputSchema = z.object({ password: z.string().min(1).max(1024) });

/** Password login: origin check, then the rate limit, then the password. Success sets a fresh session cookie. */
export async function loginAction(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const env = webEnv();
  const h = await headers();
  assertSameOrigin(h);

  const key = clientKey(h, env.TRUST_PROXY_HOPS);
  const limit = limiter.check(key);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterS / 60));
    return { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  }

  const input = LoginInputSchema.safeParse({ password: fd.get('password') });
  const ok = input.success && (await verifyPassword(input.data.password, env.OWNER_PASSWORD_HASH));
  if (!ok) {
    limiter.fail(key);
    console.warn(`login failed (bucket ${key})`);
    return { error: 'Wrong password.' };
  }

  limiter.reset(key);
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
