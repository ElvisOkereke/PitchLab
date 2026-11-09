/** How much of a page is scanned: interstitials are small, and a cap keeps a huge page cheap. */
const SCAN_CHARS = 300_000;

/** Markers anywhere in the html (lowercased) that only bot walls and interstitials use. */
const HTML_MARKERS = [
  'cf-chl', // Cloudflare challenge ids and classes
  '/cdn-cgi/challenge-platform/', // Cloudflare challenge script
  'captcha-delivery.com', // DataDome
  'px-captcha', // PerimeterX / HUMAN
  '_pxappid', // PerimeterX / HUMAN
  '_incapsula_resource', // Imperva Incapsula
  'verify you are human',
  'verify you are a human',
  'checking if the site connection is secure',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
  'please complete the security check to access',
];

/** Page titles that mean a block or interstitial (the title, not body text: an article may say "just a moment"). */
const TITLE_MARKERS = ['just a moment', 'attention required', 'access denied', 'ddos-guard', 'are you a robot', 'security check', 'one more step', 'please wait while we verify'];

/**
 * True when the html looks like a bot wall or a challenge interstitial (Cloudflare, DataDome, PerimeterX, Incapsula,
 * Akamai, DDoS-Guard, "verify you are human"). Pure, bounded (scans at most the first 300,000 characters); no regex
 * over the whole page.
 */
export function looksLikeChallenge(html: string): boolean {
  if (!html) return false;
  const s = html.slice(0, SCAN_CHARS).toLowerCase();
  if (HTML_MARKERS.some((m) => s.includes(m))) return true;
  const open = s.indexOf('<title');
  if (open >= 0) {
    const start = s.indexOf('>', open);
    const end = s.indexOf('</title>', start);
    if (start >= 0 && end > start) {
      const title = s.slice(start + 1, Math.min(end, start + 300));
      if (TITLE_MARKERS.some((m) => title.includes(m))) return true;
    }
  }
  // An <h1> bot question (some walls set no title).
  return s.includes('<h1>are you a robot');
}
