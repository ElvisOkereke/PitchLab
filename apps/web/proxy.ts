import { NextResponse, type NextRequest } from 'next/server';
import { proxyDecision } from '@/lib/auth/proxy-decision';
import { sessionCookieName, verifySession } from '@/lib/auth/session';
import { webEnv } from '@/lib/env';

/** Route guard (Next 16's renamed middleware; runs on Node): no valid session → /login?next=… */
export async function proxy(req: NextRequest) {
  const env = webEnv();
  const token = req.cookies.get(sessionCookieName(env.COOKIE_SECURE))?.value;
  const session = await verifySession(token, env.SESSION_SECRET);
  const decision = proxyDecision(req.nextUrl.pathname + req.nextUrl.search, session !== null);
  if (decision.type === 'redirect') return NextResponse.redirect(new URL(decision.to, req.url));
  return NextResponse.next();
}

// Anchored exclusions: only real build assets (`/_next/static/…`) and exactly `/favicon.ico` skip the guard, so
// look-alikes such as `/favicon.ico.evil` or `/_next/staticx` are guarded. The image optimizer is disabled
// (`images.unoptimized`), so `/_next/image` is not excluded either. Tested in test/auth/proxy-matcher.test.ts.
export const config = {
  matcher: ['/((?!_next/static/|favicon\\.ico$).*)'],
};
