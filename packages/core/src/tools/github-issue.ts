import { cleanText, getJson } from './sources/types';

/**
 * GitHub issue and pull-request pages render their body client-side, so the page fetcher sees only chrome. The verify
 * stage reads such links through GitHub's REST API instead. Requests go only to this host (GET-only, 15s timeout,
 * 2MB cap and no redirects, via `getJson`).
 */
const API_HOST = 'api.github.com';

const ISSUE_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)\/?$/;

export type GithubIssueRef = { owner: string; repo: string; number: number };

/** `https://github.com/<owner>/<repo>/issues/<n>` (or `/pull/<n>`) → its parts; anything else → null. */
export function parseGithubIssueUrl(url: string): GithubIssueRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || u.username || u.password || u.port) return null;
  const m = ISSUE_PATH.exec(u.pathname);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

type Body = { title?: unknown; body?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The issue's title, body and comment bodies (first 100 comments), each cleaned like harvested GitHub text and joined
 * by blank lines. Null when the url is not a GitHub issue or the issue call fails (non-2xx, rate limit, bad JSON), so
 * the caller can fall back to the page fetch. A failed comments call keeps the issue text alone. Never throws.
 */
export async function fetchGithubIssueText(
  url: string,
  opts: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const ref = parseGithubIssueUrl(url);
  if (!ref) return null;
  const base = new URL(`https://${API_HOST}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`);
  if (base.hostname !== API_HOST) return null;

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const issue = (await getJson('github-verify', base.href, opts.fetchImpl, headers)) as Body | null;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null;
  const comments = await getJson('github-verify', `${base.href}/comments?per_page=100`, opts.fetchImpl, headers);
  const commentBodies = Array.isArray(comments) ? comments.map((c: Body | null) => str(c?.body)) : [];

  const text = [str(issue.title), str(issue.body), ...commentBodies].map((s) => cleanText(s)).filter(Boolean).join('\n\n');
  return text || null;
}
