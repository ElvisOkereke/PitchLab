const PROFILE_URL = new RegExp(
  '(?<![\\w.@/-])(?:https?:\\/\\/)?(?:www\\.|old\\.|np\\.|m\\.|mobile\\.)?' +
    '(?:reddit\\.com\\/(?:u|user)\\/|twitter\\.com\\/|x\\.com\\/|facebook\\.com\\/|instagram\\.com\\/|github\\.com\\/|' +
    'tiktok\\.com\\/@?|medium\\.com\\/@?|youtube\\.com\\/@?|(?:[a-z]{2,3}\\.)?linkedin\\.com\\/(?:in|pub|company)\\/)' +
    '[A-Za-z0-9_.-]+[^\\s)\\]>"]*',
  'gi',
);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const REDDIT_USER = /(?<![\w/.-])\/?u\/[A-Za-z0-9_-]{3,20}(?![\w-])/g;
const AT_HANDLE = /(?<![\w@./])@[A-Za-z_][A-Za-z0-9_]{1,29}(?!\w)/g;
const POSTED_BY = /\b(posted by)\s+(?=[A-Za-z0-9_-]*[0-9_])[A-Za-z0-9_-]{3,20}(?![\w-])/gi;

/** Remove usernames, handles, emails and profile links from public text before it is stored. */
export function scrubPersonal(s: string): string {
  return s
    .replace(PROFILE_URL, '[profile removed]')
    .replace(EMAIL, '[email removed]')
    .replace(REDDIT_USER, '[user]')
    .replace(AT_HANDLE, '[user]')
    .replace(POSTED_BY, '$1 [user]')
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
