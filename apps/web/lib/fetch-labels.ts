// Plain-language labels for the page-fetch diagnostics on the Library page. Keys mirror core's FETCH_OUTCOMES and FETCH_VIAS
// (plain literals so this stays web-safe); an unknown key falls back to its words with underscores turned into spaces.

export const OUTCOME_LABEL: Record<string, string> = {
  ok: 'fetched',
  http_403: 'blocked (403)',
  http_404: 'not found (404)',
  http_410: 'gone (410)',
  http_4xx: 'refused (other 4xx)',
  http_5xx: 'site error (5xx)',
  timeout: 'timed out',
  blocked_robots: 'disallowed by robots.txt',
  blocked_host: 'not allowed (address or site)',
  too_large: 'page too large',
  not_html: 'not a web page',
  thin_text: 'too little text (needs JavaScript)',
  network: 'could not connect',
};

export const VIA_LABEL: Record<string, string> = {
  direct: 'Directly',
  archive: 'From an archived copy',
  browser: 'In the local browser',
};

export const outcomeLabel = (k: string): string => OUTCOME_LABEL[k] ?? k.replace(/_/g, ' ');
