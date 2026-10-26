import { fetchPage, type FetchPageOpts, type PageResult } from '../tools/fetch-page';
import { ROBOTS_TOKEN } from './http';

export interface RobotsOpts {
  /** Injected into the guarded page fetch (tests). */
  fetch?: typeof fetch;
  lookup?: FetchPageOpts['lookup'];
  /** Replace the guarded fetch entirely (tests). */
  fetchPage?: (url: string, opts: FetchPageOpts) => Promise<PageResult>;
  userAgent?: string;
  now?: () => number;
}

type Rule = { allow: boolean; path: string };
type Loaded = Rule[] | 'all' | 'none';
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; rules: Loaded }>();

export function resetRobotsCache(): void {
  cache.clear();
}

/** RFC 9309: a group applies when its agent equals our product token (or `pitchlab`); otherwise the `*` group. */
function parse(text: string, token: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val !== '') cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a === token || a === 'pitchlab'));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/** Linear glob match: `*` matches anything, trailing `$` anchors. No regex, so no catastrophic backtracking. */
export function matches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  if (parts.length === 1) return anchored ? path.length === first.length : true;
  const last = parts[parts.length - 1]!;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = path.indexOf(parts[i]!, pos);
    if (idx < 0) return false;
    pos = idx + parts[i]!.length;
  }
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) >= 0;
}

function decide(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

async function load(origin: string, token: string, opts: RobotsOpts): Promise<{ rules: Loaded; ttl: number }> {
  const get = opts.fetchPage ?? fetchPage;
  const r = await get(`${origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 500_000, fetchImpl: opts.fetch, lookup: opts.lookup });
  if (r.ok) return { rules: parse(r.text, token), ttl: OK_TTL_MS };
  switch (r.reason) {
    case 'blocked_host':
    case 'blocked_scheme':
    case 'timeout':
    case 'too_large':
      return { rules: 'none', ttl: FAIL_TTL_MS };
    case 'http_error':
      return r.status >= 500 || r.status === 429 ? { rules: 'none', ttl: FAIL_TTL_MS } : { rules: 'all', ttl: OK_TTL_MS };
    default: // network, not_html: robots.txt is effectively absent
      return { rules: 'all', ttl: FAIL_TTL_MS };
  }
}

/** All fetching goes through the SSRF-guarded fetchPage. 404/unreachable allow; 5xx, timeout, blocked hosts deny. */
export async function robotsAllows(url: string, opts: RobotsOpts = {}): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const now = (opts.now ?? Date.now)();
  const token = (opts.userAgent ?? ROBOTS_TOKEN).toLowerCase().split('/')[0]!;
  const key = `${u.origin}|${token}`;
  const hit = cache.get(key);
  let rules: Loaded;
  if (hit && now - hit.at < hit.ttl) rules = hit.rules;
  else {
    const l = await load(u.origin, token, opts);
    rules = l.rules;
    cache.set(key, { at: now, ttl: l.ttl, rules });
  }
  if (rules === 'all') return true;
  if (rules === 'none') return false;
  return decide(rules, u.pathname + u.search);
}
