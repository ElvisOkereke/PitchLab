export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'x' | 'threads' | 'linkedin' | 'facebook' | 'other';

/** Registrable hosts per platform; a URL matches when its host is one of these or a subdomain of one. */
const HOSTS: [Platform, string[]][] = [
  ['instagram', ['instagram.com', 'instagr.am']],
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['x', ['x.com', 'twitter.com']],
  ['threads', ['threads.net', 'threads.com']],
  ['linkedin', ['linkedin.com', 'lnkd.in']],
  ['facebook', ['facebook.com', 'fb.com', 'fb.watch']],
];

/** True for an absolute http: or https: URL. Every capture input must pass this. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

export function detectPlatform(url: string): Platform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'other';
  }
  for (const [platform, hosts] of HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return platform;
  }
  return 'other';
}
