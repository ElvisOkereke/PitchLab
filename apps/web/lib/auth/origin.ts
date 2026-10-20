function hostOf(value: string): string | null {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** An ALLOWED_ORIGINS entry as a host: `host[:port]`, or the host of a full URL. Exact matches only (no wildcards). */
function allowedHost(entry: string): string {
  return entry.includes('://') ? (hostOf(entry) ?? '') : entry.trim().toLowerCase();
}

/**
 * CSRF check for Server Actions. Next rejects a mismatched Origin but only warns when it is missing, so this also
 * rejects a missing or `null` Origin. The Origin host must equal the first X-Forwarded-Host value (when present, as in
 * Next) or else Host, or be listed in `allowed`.
 */
export function isSameOrigin(h: Headers, allowed: string[]): boolean {
  const origin = h.get('origin');
  if (!origin || origin === 'null') return false;
  const originHost = hostOf(origin);
  if (!originHost) return false;
  const forwarded = h.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = (forwarded || h.get('host') || '').toLowerCase();
  if (host && originHost === host) return true;
  return allowed.some((a) => allowedHost(a) === originHost);
}
