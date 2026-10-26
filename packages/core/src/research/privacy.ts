const PROFILE_URL = new RegExp(
  '(?<![\\w.@/-])(?:https?:\\/\\/)?(?:www\\.|old\\.|np\\.|m\\.|mobile\\.)?' +
    '(?:reddit\\.com\\/(?:u|user)\\/|twitter\\.com\\/|x\\.com\\/|facebook\\.com\\/|instagram\\.com\\/|' +
    'tiktok\\.com\\/@?|medium\\.com\\/@?|youtube\\.com\\/@?|(?:[a-z]{2,3}\\.)?linkedin\\.com\\/(?:in|pub|company)\\/)' +
    '[A-Za-z0-9_.-]+[^\\s)\\]>"]*',
  'gi',
);
// github.com/user only; org/repo and issue links are kept.
const GITHUB_PROFILE = /(?<![\w.@/-])(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+\/?(?![\w/.-])/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const REDDIT_USER = /(?<![\w/.-])\/?u\/[A-Za-z0-9_-]{3,20}(?![\w-])/g;
const AT_HANDLE = /(?<![\w@./])@[A-Za-z_][A-Za-z0-9_]{1,29}(?!\w)/g;
const POSTED_BY = /\b(posted\s+by:?)\s+([\w.@[\]-]+)(\s+[\w'-]+)?/gi;
const BYLINE_STOP = new Set(['the', 'a', 'an', 'our', 'my', 'your', 'their', 'this', 'someone', 'anonymous']);

function scrubByline(match: string, lead: string, name: string, next: string | undefined): string {
  if (BYLINE_STOP.has(name.toLowerCase())) return match;
  const dropNext = next !== undefined && /^\s+[A-Z][a-z'-]+$/.test(next);
  return `${lead} [user]${dropNext || next === undefined ? '' : next}`;
}

/** Remove usernames, handles, emails and profile links from public text before it is stored. */
export function scrubPersonal(s: string): string {
  return s
    .replace(PROFILE_URL, '[profile removed]')
    .replace(GITHUB_PROFILE, '[profile removed]')
    .replace(EMAIL, '[email removed]')
    .replace(REDDIT_USER, '[user]')
    .replace(AT_HANDLE, '[user]')
    .replace(POSTED_BY, scrubByline)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Cap at 500 characters, cutting on a word boundary. */
export function capQuote(s: string): string {
  if (s.length <= 500) return s;
  const cut = s.slice(0, 500);
  const sp = cut.lastIndexOf(' ');
  return (sp > 250 ? cut.slice(0, sp) : cut).trimEnd();
}
