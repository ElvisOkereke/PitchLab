import { and, count, gte, sql } from 'drizzle-orm';
import { parse } from 'tldts';
import type { Db } from '../db/client';
import { FETCH_VIAS, pageFetches } from '../db/schema';
import type { PageResult } from '../tools/fetch-page';

export type FetchOutcome = (typeof pageFetches.$inferInsert)['outcome'] & string;
export type FetchVia = (typeof FETCH_VIAS)[number];

/** Maps a fetch result (or a robots refusal / thin-text finding) to the logged outcome. */
export function classifyFetch(result: PageResult | { robots: false } | { thin: true }): FetchOutcome {
  if ('robots' in result) return 'blocked_robots';
  if ('thin' in result) return 'thin_text';
  if (result.ok) return 'ok';
  switch (result.reason) {
    case 'http_error':
      if (result.status === 403) return 'http_403';
      if (result.status === 404) return 'http_404';
      if (result.status === 410) return 'http_410';
      if (result.status >= 500) return 'http_5xx';
      // Also covers an unexpected status below 400 on a failed result (fetchPage does not produce one): treated as a client error.
      return 'http_4xx';
    case 'timeout': return 'timeout';
    case 'too_large': return 'too_large';
    case 'not_html': return 'not_html';
    case 'blocked_scheme':
    case 'blocked_host': return 'blocked_host';
    default: return 'network';
  }
}

/** Logs one fetch attempt (registrable domain only). Never throws: diagnostics must not break a mission. */
export async function recordFetch(
  db: Db,
  o: { url: string; outcome: FetchOutcome; via: FetchVia; status?: number; missionId?: string; runId?: string },
): Promise<void> {
  try {
    const host = new URL(o.url).hostname;
    const urlDomain = parse(host).domain ?? host;
    await db.insert(pageFetches).values({
      urlDomain, outcome: o.outcome, via: o.via, status: o.status ?? null, missionId: o.missionId ?? null, runId: o.runId ?? null,
    });
  } catch (err) {
    console.error(`fetch log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type FetchStats = {
  total: number;
  ok: number;
  okRate: number | null;
  byVia: Record<FetchVia, { total: number; ok: number }>;
  byOutcome: Record<string, number>;
  topFailing: { domain: string; failures: number; topOutcome: string }[];
};

const TOP_FAILING = 10;

/** Fetch outcomes over the last `days` days: success rate, split by route, and the worst domains. */
export async function fetchStats(db: Db, { days = 30 }: { days?: number } = {}): Promise<FetchStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const inWindow = gte(pageFetches.at, since);
  const rows = await db.select({ via: pageFetches.via, outcome: pageFetches.outcome, n: count() })
    .from(pageFetches).where(inWindow).groupBy(pageFetches.via, pageFetches.outcome);
  const byVia = Object.fromEntries(FETCH_VIAS.map((v) => [v, { total: 0, ok: 0 }])) as FetchStats['byVia'];
  const byOutcome: Record<string, number> = {};
  let total = 0;
  let ok = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    byVia[r.via].total += n;
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + n;
    if (r.outcome === 'ok') { ok += n; byVia[r.via].ok += n; }
  }
  const failing = await db.select({
    domain: pageFetches.urlDomain,
    failures: count(),
    topOutcome: sql<string>`mode() within group (order by ${pageFetches.outcome}::text)`,
  }).from(pageFetches)
    .where(and(inWindow, sql`${pageFetches.outcome} <> 'ok'`))
    .groupBy(pageFetches.urlDomain)
    .orderBy(sql`count(*) desc`, pageFetches.urlDomain)
    .limit(TOP_FAILING);
  return {
    total, ok, okRate: total > 0 ? ok / total : null, byVia, byOutcome,
    topFailing: failing.map((f) => ({ domain: f.domain, failures: Number(f.failures), topOutcome: f.topOutcome })),
  };
}
