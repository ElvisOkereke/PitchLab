const BASE = 'http://x';
const MAX_LENGTH = 2048;
// Backslashes and control characters are never needed in our paths, and browsers treat '\' like '/'.
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

function isLocalPath(s: string): boolean {
  if (!s.startsWith('/') || s[1] === '/' || s[1] === '\\' || UNSAFE_CHARS.test(s)) return false;
  try {
    return new URL(s, BASE).origin === BASE;
  } catch {
    return false;
  }
}

/**
 * Where to go after login: `raw` when it is a same-origin relative path (also once percent-decoded), else `/`.
 * Blocks `//host`, `/\host`, absolute and `javascript:` URLs and encoded variants such as `/%2F%2Fhost`.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  return isLocalPath(raw) && isLocalPath(decoded) ? raw : '/';
}
