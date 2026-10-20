// Ruling D2-R1: error text that reaches storage or the dashboard (run errors) must not carry credentials.
// Every pattern is linear: fixed or anchored starts, single character-class runs, bounded quoted values, no nesting.

const R = '[redacted]';

/** URLs of these schemes lose their userinfo, query string and fragment: `https://u:p@host/path?x=1` → `https://host/path`. */
const URL_PARTS = /\b(https?|postgres(?:ql)?|wss?|ftp|redis|mongodb(?:\+srv)?)(:\/\/)(?:[^\s/?#@]*@)?([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi;
/** `Authorization: <anything to the end of the value>` (headers, JSON). */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?)[^\r\n"',}]+/gi;
const BEARER = /\b(bearer\s+)[^\s,;"']+/gi;
/** `api_key=…`, `token: "…"`, `password='…'`, `client_secret=…` (the name may follow `_`). */
const ASSIGNMENT = /(?<![A-Za-z])((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*)(?:"[^"\r\n]{0,500}"|'[^'\r\n]{0,500}'|[^\s&,;"']+)/gi;
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
 * Replaces credential-looking text with `[redacted]`: URL userinfo and query strings, `Authorization` values, bearer
 * tokens, `api_key|token|secret|password` assignments, provider key shapes (sk-, xoxb-, ghp_, AKIA…, AIza…) and any
 * 24+ character token mixing letters and digits. Ordinary error messages pass through unchanged.
 */
export function scrubSecrets(text: string): string {
  let s = text
    .replace(URL_PARTS, '$1$2$3')
    .replace(AUTH_HEADER, `$1${R}`)
    .replace(BEARER, `$1${R}`)
    .replace(ASSIGNMENT, `$1${R}`);
  for (const re of KEY_SHAPES) s = s.replace(re, R);
  return s.replace(LONG_RUN, (m) => (LETTER.test(m) && DIGIT.test(m) ? R : m));
}
