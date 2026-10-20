import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { webEnv } from '../env';
import { isSameOrigin } from './origin';
import { sessionCookieName, verifySession } from './session';

/** The owner's session from the request cookie, or null. */
export async function currentSession() {
  const env = webEnv();
  const token = (await cookies()).get(sessionCookieName(env.COOKIE_SECURE))?.value;
  return verifySession(token, env.SESSION_SECRET);
}

/** Second layer behind proxy.ts for pages, layouts and route handlers: no valid session → /login. */
export async function requireOwner(): Promise<void> {
  if (!(await currentSession())) redirect('/login');
}

/**
 * First call in every Server Action: a missing, `null` or foreign Origin throws `Forbidden`; no valid session
 * redirects to /login. Nothing is read or written before both pass.
 */
export async function requireOwnerAction(): Promise<void> {
  assertSameOrigin(await headers());
  if (!(await currentSession())) redirect('/login');
}

/** Throws `Forbidden` unless the request's Origin is this app (or an ALLOWED_ORIGINS host). */
export function assertSameOrigin(h: Headers): void {
  if (!isSameOrigin(h, webEnv().ALLOWED_ORIGINS)) throw new Error('Forbidden');
}
