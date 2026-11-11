import { and, asc, eq, exists, gt, isNotNull, or, sql } from 'drizzle-orm';
import { torontoDayStart } from '../dashboard/command';
import type { Db } from '../db/client';
import { cases, ideas, knowledgeItems, knowledgeSources, llmCalls } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import type { ModelRouter } from '../llm/types';
import { capField, stripInvisible } from '../llm/untrusted';
import type { Collected } from '../research/collect';
import { errorMessage } from '../tools/scrub';
import { getSetting, setSetting } from '../validation/settings';
import { buildDossier } from './dossier';
import { DOSSIERS_STATS_KEY } from './dossier-status';
import { parseFacts } from './kinds';

export const DOSSIERS_DAILY_USD_KEY = 'dossiers.dailyUsd';
export const DOSSIERS_PRIORITY_KEY = 'dossiers.priority';
export const DOSSIERS_LAST_RUN_KEY = 'dossiers.lastRun';
export const DEFAULT_DOSSIERS_DAILY_USD = 2;
/** A dossier older than this is rebuilt. */
export const DOSSIER_REFRESH_DAYS = 180;
/** Startups per worker run (the daily cap is the real limit). */
export const DEFAULT_DOSSIER_LIMIT = 25;
/** The worker builds dossiers at most this often. */
const EVERY_MS = 3_600_000;
const CANDIDATES_MAX = 5000;
/** After a failure the entry waits 7 days times its failures in a row (at most 180 days); the third failure ends the retries until the 180-day refresh. */
export const FAILURE_BACKOFF_DAYS = 7;
export const MAX_FAILURES = 3;
const backoffMs = (failures: number): number => Math.min(FAILURE_BACKOFF_DAYS * Math.max(1, failures), DOSSIER_REFRESH_DAYS) * 86_400_000;
const PRIORITY_MAX = 1000;

export type DossierJobDeps = {
  db: Db;
  router: ModelRouter;
  /** One page through the guarded collector. */
  collectPage: (url: string) => Promise<Collected>;
  log: (m: string) => void;
  now?: () => Date;
  /** Startups this run (default 25). */
  limit?: number;
  /** A hard cap for this run only (`gen dossiers run --max-usd`); when given it replaces the daily cap for this run (a backfill). */
  maxUsd?: number;
  /** True (a run is queued) stops the job between startups. */
  shouldYield?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
};

export type DossierJobResult = { done: number; unmatched: number; failed: number; spentUsd: number };

const asDaily = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50 ? v : DEFAULT_DOSSIERS_DAILY_USD);
export const dossiersDailyUsd = async (db: Db): Promise<number> => asDaily(await getSetting(db, DOSSIERS_DAILY_USD_KEY));

/** Model spend of the dossiers since Toronto midnight (their llm_calls rows carry the `dossier.` prompt version). */
export async function dossiersSpentToday(db: Db, now: Date): Promise<number> {
  const [r] = await db.select({ s: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text` }).from(llmCalls)
    .where(sql`${llmCalls.promptVersion} like ${'dossier.%'} and ${llmCalls.createdAt} >= ${torontoDayStart(now).toISOString()}::timestamptz`);
  return Number(r?.s ?? 0);
}

/**
 * Startup entries that need a dossier (never had one, or one older than 180 days), best first: cited by a case or a
 * kept idea (owner-rated up or advanced); in the `dossiers.priority` setting (written by evolve); business model
 * unknown; the rest. Within a group, oldest entry first.
 */
export async function dossierQueue(db: Db, limit: number, now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - DOSSIER_REFRESH_DAYS * 86_400_000).toISOString();
  const all = await db.select({ id: knowledgeItems.id, model: sql<string | null>`${knowledgeItems.facts}->>'businessModel'`, failedAt: sql<string | null>`${knowledgeItems.facts}->>'dossierFailedAt'`, failures: sql<string | null>`${knowledgeItems.facts}->>'dossierFailures'` }).from(knowledgeItems)
    .where(and(
      eq(knowledgeItems.kind, 'startup'), eq(knowledgeItems.status, 'active'),
      sql`(${knowledgeItems.facts}->>'dossierAt' is null or ${knowledgeItems.facts}->>'dossierAt' < ${cutoff})`,
    ))
    .orderBy(asc(knowledgeItems.createdAt), asc(knowledgeItems.id)).limit(CANDIDATES_MAX);
  const rows = all.filter((r) => {
    const t = r.failedAt ? Date.parse(r.failedAt) : NaN;
    return !Number.isFinite(t) || now.getTime() >= t + backoffMs(Number(r.failures) || 1);
  });
  const citing = await db.select({ ids: ideas.libraryItemIds }).from(ideas)
    .where(and(
      isNotNull(ideas.libraryItemIds),
      or(exists(db.select({ one: sql`1` }).from(cases).where(eq(cases.ideaId, ideas.id))), gt(ideas.ownerRating, 0), eq(ideas.status, 'advanced')),
    )).limit(CANDIDATES_MAX);
  const cited = new Set(citing.flatMap((r) => r.ids ?? []));
  const p = await getSetting(db, DOSSIERS_PRIORITY_KEY);
  const priority = new Set(Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string').slice(0, PRIORITY_MAX) : []);
  const rank = (r: (typeof rows)[number]): number =>
    cited.has(r.id) ? 0 : priority.has(r.id) ? 1 : !r.model || r.model.trim().toLowerCase() === 'unknown' ? 2 : 3;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).slice(0, Math.max(0, limit)).map((x) => x.r.id);
}

/** Runs unconditionally (`gen dossiers run`, or the worker when due). Never throws; stops at `maxUsd` when given, else at the daily cap. */
export async function runDossierJob(deps: DossierJobDeps): Promise<DossierJobResult> {
  const { db, router, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const result: DossierJobResult = { done: 0, unmatched: 0, failed: 0, spentUsd: 0 };
  const warnings: string[] = [];
  const warn = (w: string) => {
    const msg = capField(stripInvisible(w), 200);
    if (warnings.length < 10 && !warnings.includes(msg)) warnings.push(msg);
    log(`dossiers: ${msg}`);
  };
  await setSetting(db, DOSSIERS_LAST_RUN_KEY, now.toISOString());
  try {
    // An explicit --max-usd (a backfill) replaces the daily cap for this run; the worker never passes one.
    const explicit = deps.maxUsd !== undefined;
    const cap = await dossiersDailyUsd(db);
    const before = await dossiersSpentToday(db, now);
    const spent = async () => Math.max(0, (await dossiersSpentToday(db, now)) - before);
    if (!explicit && before >= cap) {
      warn(`daily cap of $${cap} reached; skipped this run`);
    } else {
      const ctx = { runId: null, missionId: null, promptVersion: loadPrompt('dossier').version };
      for (const id of await dossierQueue(db, deps.limit ?? DEFAULT_DOSSIER_LIMIT, now)) {
        if (deps.signal?.aborted || (deps.shouldYield && (await deps.shouldYield()))) {
          warn('paused for queued work; the rest waits for the next run');
          break;
        }
        if (!explicit && before + (await spent()) >= cap) {
          warn(`daily cap of $${cap} reached; stopped`);
          break;
        }
        if (deps.maxUsd !== undefined && (await spent()) >= deps.maxUsd) {
          warn(`--max-usd of $${deps.maxUsd} reached; stopped`);
          break;
        }
        try {
          const outcome = await processItem(db, id, { collectPage: deps.collectPage, router, ctx }, now);
          if (outcome) result[outcome]++;
        } catch (e) {
          result.failed++;
          warn(`failed: ${errorMessage(e)}`);
        }
      }
    }
    result.spentUsd = await spent();
  } catch (e) {
    warn(`failed: ${errorMessage(e)}`);
  }
  await setSetting(db, DOSSIERS_STATS_KEY, { at: now.toISOString(), ...result, warnings });
  log(`dossiers: ${result.done} done, ${result.unmatched} unmatched, ${result.failed} failed, $${result.spentUsd.toFixed(2)} spent`);
  return result;
}

function withoutFailures(f: Record<string, unknown>): Record<string, unknown> {
  const { dossierFailedAt: _a, dossierFailures: _b, ...rest } = f;
  return rest;
}

/** Records a failure with its time and count (the queue backs off); the third in a row also sets dossierAt, so only the 180-day refresh retries it. */
async function recordFailure(db: Db, id: string, old: Record<string, unknown>, now: Date): Promise<void> {
  const failures = (typeof old.dossierFailures === 'number' ? old.dossierFailures : 0) + 1;
  const facts = { ...old, dossierStatus: 'failed', dossierFailedAt: now.toISOString(), dossierFailures: failures, ...(failures >= MAX_FAILURES ? { dossierAt: now.toISOString() } : {}) };
  await db.update(knowledgeItems).set({ facts, updatedAt: now }).where(eq(knowledgeItems.id, id));
}

async function processItem(db: Db, id: string, deps: Parameters<typeof buildDossier>[1], now: Date): Promise<'done' | 'unmatched' | 'failed' | null> {
  const [row] = await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.kind, 'startup'), eq(knowledgeItems.status, 'active')));
  if (!row) return null;
  const sources = await db.select({ url: knowledgeSources.url }).from(knowledgeSources).where(eq(knowledgeSources.itemId, id)).limit(10);
  const old = row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? (row.facts as Record<string, unknown>) : {};
  const r = await buildDossier({ id, title: row.title, summary: row.summary, facts: row.facts, sourceUrls: sources.map((s) => s.url) }, deps);
  if (r.status === 'unmatched') {
    // The old facts stay; only the status and time are recorded, so the same company is not tried again for 180 days.
    await db.update(knowledgeItems).set({ facts: { ...withoutFailures(old), dossierStatus: 'unmatched', dossierAt: now.toISOString() }, updatedAt: now }).where(eq(knowledgeItems.id, id));
    return 'unmatched';
  }
  if (r.status === 'failed') {
    await recordFailure(db, id, old, now);
    return 'failed';
  }
  let merged: unknown;
  try {
    merged = parseFacts('startup', { ...withoutFailures(old), ...r.facts, dossierStatus: 'done', dossierAt: now.toISOString() });
  } catch {
    await recordFailure(db, id, old, now);
    return 'failed';
  }
  await db.transaction(async (tx) => {
    await tx.update(knowledgeItems).set({ facts: merged, ...(r.summary && r.summary !== row.summary ? { summary: r.summary } : {}), updatedAt: now }).where(eq(knowledgeItems.id, id));
    for (const s of r.sources ?? []) {
      let domain = '';
      try {
        domain = new URL(s.url).hostname;
      } catch {
        continue;
      }
      await tx.insert(knowledgeSources).values({ itemId: id, url: s.url, domain, sourceType: 'web', quote: s.quote, quoteVerified: true, fetchedAt: now }).onConflictDoNothing();
    }
  });
  return 'done';
}

/** The worker's entry: runs when the last run (`dossiers.lastRun`) is at least an hour old; null otherwise. */
export async function runDueDossierJob(deps: DossierJobDeps): Promise<DossierJobResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  const last = await getSetting(deps.db, DOSSIERS_LAST_RUN_KEY);
  const t = typeof last === 'string' ? Date.parse(last) : NaN;
  if (Number.isFinite(t) && now.getTime() < t + EVERY_MS) return null;
  return runDossierJob(deps);
}
