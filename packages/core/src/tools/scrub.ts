// Rulings D2-R1/D2-R2: error text that is persisted (runs.error, llm_calls.error) or surfaced in the dashboard must not
// carry credentials. Every pattern is linear: anchored starts (lookbehind or a fixed prefix), single character-class
// runs, bounded quoted values, no nested quantifiers.

const R = '[redacted]';

/**
 * A URL of any scheme. The lookbehind only lets a scheme start at the beginning of a run of scheme characters, so a
 * long run without `://` is scanned once, not once per position.
 */
const URL_PARTS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):\/\/([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi;
/** `Authorization: <anything to the end of the value>` (headers, JSON). */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?)[^\r\n"',}]+/gi;
const BEARER = /\b(bearer\s+)[^\s,;"']+/gi;
const KEYWORDS = [
  'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'client[_-]?secret', 'refresh[_-]?token', 'token', 'secret', 'password',
  'passwd', 'pwd', 'cookies?', 'sessions?', 'credentials?', 'signature', 'auth',
].join('|');
/**
 * `<keyword>=value` / `<keyword>: "value"` (the keyword may follow `_` or `-`, e.g. access_token, Set-Cookie). A quoted
 * value closed within 500 chars is redacted with its quotes; an unclosed quote redacts to the end of the line.
 */
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z])((?:${KEYWORDS})["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]{0,500}"|'[^'\\r\\n]{0,500}'|["'][^\\r\\n]*|[^\\s&,;"']+)`,
  'gi',
);
/** Anchored by lookbehind (not \b, which lets "eyJ" start after "-" inside a run and goes quadratic). */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
/** Provider key shapes, including short ones the generic rule below would miss. */
const KEY_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
];
/** Any whole run of 24+ [A-Za-z0-9_-] characters; redacted when it holds both letters and digits. */
const LONG_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}/g;
const LETTER = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/**
 * `scheme://host/path` with userinfo (up to the last `@` before the path), query and fragment removed. `url` is the
 * whole match (query and fragment included) and `rest` the part between `://` and the first `?`/`#`.
 */
function cleanUrl(url: string, scheme: string, rest: string): string {
  const slash = rest.indexOf('/');
  const hasPath = slash !== -1;
  try {
    const u = new URL(url);
    if (u.host || !url.includes('@')) return `${u.protocol}//${u.host}${hasPath ? u.pathname : ''}`;
  } catch {
    // Not a URL the WHATWG parser accepts: fall back below.
  }
  // D2-R3: fail closed. An unparseable URL with an @ anywhere may hold an unencoded password ("u:pa/ss@", "u:p#w@").
  if (url.includes('@')) return `${scheme}://${R}`;
  return `${scheme}://${rest}`;
}

/**
 * Replaces credential-looking text with `[redacted]`: URL userinfo, query strings and fragments (any scheme),
 * `Authorization` values, bearer tokens, secret-named assignments (api_key, token, secret, password, cookie, session,
 * auth, credential, private_key, signature, …), JWTs, provider key shapes (sk-, xoxb-, ghp_, AKIA…, AIza…) and any 24+
 * character token mixing letters and digits. Ordinary error messages pass through unchanged.
 */
export function scrubSecrets(text: string): string {
  let s = text
    .replace(URL_PARTS, (m: string, scheme: string, rest: string) => cleanUrl(m, scheme, rest))
    .replace(AUTH_HEADER, `$1${R}`)
    .replace(BEARER, `$1${R}`)
    .replace(ASSIGNMENT, `$1${R}`)
    .replace(JWT, R);
  for (const re of KEY_SHAPES) s = s.replace(re, R);
  return s.replace(LONG_RUN, (m) => (LETTER.test(m) && DIGIT.test(m) ? R : m));
}

/** Longest error text kept; cut BEFORE scrubbing so a huge message never reaches the patterns (D2-R3). */
export const ERROR_TEXT_MAX = 16_384;

/** Stored or legacy error text, cut to ERROR_TEXT_MAX and scrubbed (dashboard read sites). */
export function scrubError(text: string): string {
  return scrubSecrets(text.slice(0, ERROR_TEXT_MAX));
}

/** The scrubbed message of anything thrown. Every site that persists or surfaces an error message uses this. */
export function errorMessage(err: unknown): string {
  return scrubError(err instanceof Error ? err.message : String(err));
}
