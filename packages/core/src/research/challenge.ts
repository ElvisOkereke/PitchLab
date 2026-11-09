/** How much of a page is scanned: interstitials are small, and a cap keeps a huge page cheap. */
const SCAN_CHARS = 300_000;
/** Readable text under this many characters is an interstitial-sized page (weak markers count only then). */
export const CHALLENGE_TEXT_CHARS = 1_500;

/**
 * Markers only interstitials carry: each one alone means a challenge. Bot-defence scripts that also run on ordinary
 * pages (Cloudflare's jsd snippet under /cdn-cgi/challenge-platform/scripts/, the PerimeterX sensor `_pxAppId`, an
 * Incapsula resource script) are not here.
 */
const STRONG_MARKERS = [
  'cf-chl', // Cloudflare challenge ids and classes (cf-chl-widget, cf-chl-opt)
  'cf_chl_opt', // Cloudflare challenge options object
  '/cdn-cgi/challenge-platform/h/', // Cloudflare challenge orchestration
  'chl_page', // Cloudflare challenge page script
  'px-captcha', // PerimeterX / HUMAN block page
  'captcha-delivery.com', // DataDome interstitial
  'incapsula incident id', // Imperva "Request unsuccessful" page
];

/** Markers that also appear on ordinary pages: they count only on a page with little readable text. */
const WEAK_MARKERS = [
  '/cdn-cgi/challenge-platform/',
  '_pxappid',
  '_incapsula_resource',
  'verify you are human',
  'verify you are a human',
  'checking if the site connection is secure',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'please complete the security check',
  'are you a robot',
  'request unsuccessful',
];

/** Whole-title interstitials (start of the title): a challenge on their own. */
const STRONG_TITLES = [/^just a moment/, /^attention required!?\s*\|\s*cloudflare/, /^ddos-guard$/, /^access to this page has been denied/];
/** Generic titles: a challenge only on a thin page. */
const WEAK_TITLES = ['security check', 'access denied', 'one more step', 'please wait while we verify', 'are you a robot', 'attention required'];

/** The lowercased title, or ''. */
function titleOf(s: string): string {
  const open = s.indexOf('<title');
  if (open < 0) return '';
  const start = s.indexOf('>', open);
  const end = start < 0 ? -1 : s.indexOf('</title>', start);
  return start >= 0 && end > start ? s.slice(start + 1, Math.min(end, start + 300)).trim() : '';
}

/** Removes `<tag ...>...</tag>` blocks with indexOf (linear, no backtracking). */
function dropBlocks(s: string, tag: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = s.indexOf(`<${tag}`, i);
    if (open < 0) return out + s.slice(i);
    out += s.slice(i, open);
    const close = s.indexOf(`</${tag}>`, open);
    if (close < 0) return out;
    i = close + tag.length + 3;
  }
}

/** Approximate readable-text length: scripts, styles, head and tags removed, whitespace collapsed. */
function readableLength(s: string): number {
  let t = dropBlocks(dropBlocks(dropBlocks(dropBlocks(s, 'script'), 'style'), 'noscript'), 'head');
  let out = '';
  let inTag = false;
  for (const ch of t) {
    if (ch === '<') inTag = true;
    else if (ch === '>') { inTag = false; out += ' '; }
    else if (!inTag) out += ch;
  }
  t = out.replace(/\s+/g, ' ').trim();
  return t.length;
}

/**
 * True when the html looks like a bot wall or a challenge interstitial (Cloudflare, DataDome, PerimeterX, Incapsula,
 * Akamai, DDoS-Guard, "verify you are human"). Interstitial-only markers and whole interstitial titles count alone;
 * infrastructure markers, generic titles and body phrases count only when the page has under 1,500 characters of
 * readable text, so an article about CAPTCHAs or a page that merely loads a bot-defence script is not a challenge.
 * Pure and bounded (scans at most the first 300,000 characters).
 */
export function looksLikeChallenge(html: string): boolean {
  if (!html) return false;
  const s = html.slice(0, SCAN_CHARS).toLowerCase();
  if (STRONG_MARKERS.some((m) => s.includes(m))) return true;
  const title = titleOf(s);
  if (title && STRONG_TITLES.some((re) => re.test(title))) return true;
  const weak = WEAK_MARKERS.some((m) => s.includes(m)) || (title !== '' && WEAK_TITLES.some((m) => title.includes(m)));
  return weak && readableLength(s) < CHALLENGE_TEXT_CHARS;
}
