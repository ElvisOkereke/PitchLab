const PROFILE_URL =
  /https?:\/\/(?:www\.|old\.|np\.|mobile\.)?(?:reddit\.com\/(?:u|user)\/|twitter\.com\/|x\.com\/|(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub|company)\/)[^\s)\]>"]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Remove usernames, handles, emails and profile links from public text before it is stored. */
export function scrubPersonal(s: string): string {
  return s
    .replace(PROFILE_URL, '[profile removed]')
    .replace(EMAIL, '[email removed]')
    .replace(/(^|[^\w])\/?u\/[A-Za-z0-9_-]+/g, '$1[user]')
    .replace(/(^|[^\w@])@[A-Za-z0-9_]{2,}/g, '$1[user]')
    .replace(/\bposted by\s+\S+/gi, 'posted by [user]')
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
