export type ProxyDecision = { type: 'next' } | { type: 'redirect'; to: string };

const LOGIN = '/login';
/** Static assets the proxy matcher already skips; listed here too so the decision is safe on its own. */
const STATIC_PREFIXES = ['/_next/static/', '/_next/image'];
const STATIC_FILES = new Set(['/favicon.ico']);

/**
 * The route guard. `path` is the pathname plus any query string. `/login` is the only public page (an authed visit
 * goes home); every other path without a session redirects to `/login?next=<path+search>`.
 */
export function proxyDecision(path: string, hasSession: boolean): ProxyDecision {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (STATIC_FILES.has(pathname) || STATIC_PREFIXES.some((p) => pathname.startsWith(p))) return { type: 'next' };
  if (pathname === LOGIN) return hasSession ? { type: 'redirect', to: '/' } : { type: 'next' };
  if (hasSession) return { type: 'next' };
  return { type: 'redirect', to: `${LOGIN}?next=${encodeURIComponent(path)}` };
}
