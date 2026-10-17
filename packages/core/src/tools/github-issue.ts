import { cleanText, getJson } from './sources/types';

/**
 * GitHub issue and pull-request pages render their body client-side, so the page fetcher sees only chrome. The verify
 * stage reads such links through GitHub's REST API instead: GET-only, 15s timeout, 2MB cap and no redirects (via
 * `getJson`), always to api.github.com.
 *
 * The calls are deliberately unauthenticated. The repo comes from case content (untrusted), so the operator's
 * GITHUB_TOKEN must never be sent on its behalf; public issues need no token, and 60 requests/hour is enough for verify.
 */
const API_BASE = 'https://api.github.com/repos';

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

/**
 * `issueText`: the issue's own title and body, written by its author. `fullText`: that plus the comment bodies (first
 * 100). Anyone can comment on a public issue, so only `issueText` may auto-verify an exact quote; `fullText` is context
 * for the judge.
 */
export type GithubIssueText = { issueText: string; fullText: string };

type Body = { title?: unknown; body?: unknown };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const join = (parts: string[]) => parts.map((s) => cleanText(s)).filter(Boolean).join('\n\n');

/**
 * The issue text, each part cleaned like harvested GitHub text and joined by blank lines. Null when the url is not a
 * GitHub issue or the issue call fails (non-2xx, rate limit, bad JSON), so the caller can fall back to the page fetch.
 * A failed comments call keeps the issue text alone. Never throws.
 */
export async function fetchGithubIssueText(url: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<GithubIssueText | null> {
  const ref = parseGithubIssueUrl(url);
  if (!ref) return null;
  const issueUrl = `${API_BASE}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

  const issue = (await getJson('github-verify', issueUrl, opts.fetchImpl, headers)) as Body | null;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null;
  const comments = await getJson('github-verify', `${issueUrl}/comments?per_page=100`, opts.fetchImpl, headers);
  const commentBodies = Array.isArray(comments) ? comments.map((c: Body | null) => str(c?.body)) : [];

  const issueText = join([str(issue.title), str(issue.body)]);
  const fullText = join([str(issue.title), str(issue.body), ...commentBodies]);
  return fullText ? { issueText, fullText } : null;
}
