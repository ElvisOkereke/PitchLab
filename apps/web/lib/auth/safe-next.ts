const BASE = 'http://x';
const MAX_LENGTH = 2048;
// Backslashes and control characters are never needed in our paths, and browsers treat '\' like '/'.
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

/** The normalised same-origin path (dot segments resolved), or null when `s` is not one or normalises to `//host`. */
function localPath(s: string): string | null {
  if (!s.startsWith('/') || s[1] === '/' || s[1] === '\\' || UNSAFE_CHARS.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s, BASE);
  } catch {
    return null;
  }
  // `/.//evil.com` and `/%2E//evil.com` normalise to the pathname `//evil.com`, which a browser reads as a host.
  if (u.origin !== BASE || u.pathname.startsWith('//')) return null;
  return u.pathname + u.search + u.hash;
}

/**
 * Where to go after login: the NORMALISED form of `raw` when it is a same-origin relative path (also once
 * percent-decoded), else `/`. Never returns the raw input. Blocks `//host`, `/\host`, absolute and `javascript:` URLs,
 * encoded variants such as `/%2F%2Fhost` and dot-segment variants such as `/..//host`.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  const normalised = localPath(raw);
  return normalised !== null && localPath(decoded) !== null && localPath(normalised) === normalised ? normalised : '/';
}
