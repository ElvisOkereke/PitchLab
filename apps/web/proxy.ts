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

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
