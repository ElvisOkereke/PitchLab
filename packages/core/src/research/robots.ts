export interface RobotsOpts {
  fetch?: typeof fetch;
  userAgent?: string;
  now?: () => number;
}

type Rule = { allow: boolean; path: string };
type Loaded = Rule[] | 'all' | 'none';
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UA = 'pitchlab-research';
const cache = new Map<string, { at: number; rules: Loaded }>();

export function resetRobotsCache(): void {
  cache.clear();
}

/** Pick rules from the group naming our UA token, else the `*` group. */
function parse(text: string, ua: string): Rule[] {
  const token = ua.toLowerCase().split('/')[0]!;
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
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function matches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const esc = body
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + esc + (anchored ? '$' : '')).test(path);
}

function decide(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

async function load(origin: string, ua: string, f?: typeof fetch): Promise<Loaded> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await (f ?? fetch)(`${origin}/robots.txt`, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': ua },
    });
    if (res.status >= 500) return 'none';
    if (res.status >= 400) return 'all';
    return parse((await res.text()).slice(0, 500_000), ua);
  } catch (e) {
    if (controller.signal.aborted || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))) return 'none';
    return 'all';
  } finally {
    clearTimeout(timer);
  }
}

/** Fail open on 404/unreachable, fail closed on 5xx/timeout. Cached per origin for 24 h. */
export async function robotsAllows(url: string, opts: RobotsOpts = {}): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const now = (opts.now ?? Date.now)();
  const ua = opts.userAgent ?? DEFAULT_UA;
  const key = `${u.origin}|${ua}`;
  const hit = cache.get(key);
  let rules: Loaded;
  if (hit && now - hit.at < TTL_MS) rules = hit.rules;
  else {
    rules = await load(u.origin, ua, opts.fetch);
    cache.set(key, { at: now, rules });
  }
  if (rules === 'all') return true;
  if (rules === 'none') return false;
  return decide(rules, u.pathname + u.search);
}
