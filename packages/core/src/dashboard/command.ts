import { and, count, desc, eq, gte, isNull, lt, max, ne, notExists, or, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cases, dataCalls, llmCalls, outreachEvents, prospects, runs, scores, stageEvents } from '../db/schema';
import { scrubSecrets } from '../tools/scrub';

// ---- Toronto days ("today" / "this week" are America/Toronto days; weeks start Monday) --------------

const TZ = 'America/Toronto';
const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function wall(d: Date) {
  const p = Object.fromEntries(WALL.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Toronto wall clock minus UTC, in ms, at instant `t` (negative: -4 h in summer, -5 h in winter). */
function offsetAt(t: number): number {
  const w = wall(new Date(t));
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** The instant of 00:00 Toronto time on the given calendar day (DST changes happen at 02:00, never at midnight). */
function torontoMidnight(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** Start of the Toronto calendar day containing `now`. */
export function torontoDayStart(now: Date): Date {
  const w = wall(now);
  return torontoMidnight(w.y, w.m, w.d);
}

/** Monday 00:00 Toronto time of the week containing `now`. */
export function torontoWeekStart(now: Date): Date {
  const w = wall(now);
  const back = (new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(w.y, w.m - 1, w.d - back));
  return torontoMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

// ---- Spend ---------------------------------------------------------------------------------------

/** Model spend (notional, from the price table) and data-API spend recorded since `since`, all runs included. */
export async function spendSince(db: Db, since: Date): Promise<{ llmUsd: number; dataUsd: number; llmCalls: number }> {
  const [[llm], [data]] = await Promise.all([
    db.select({ total: sum(llmCalls.costUsd), n: count() }).from(llmCalls).where(gte(llmCalls.createdAt, since)),
    db.select({ total: sum(dataCalls.costUsd) }).from(dataCalls).where(gte(dataCalls.createdAt, since)),
  ]);
  return { llmUsd: Number(llm?.total ?? 0), dataUsd: Number(data?.total ?? 0), llmCalls: llm?.n ?? 0 };
}

// ---- Needs you -----------------------------------------------------------------------------------

export type NeedsYouItem = { kind: 'score' | 'advisory' | 'reply' | 'failed_run'; label: string; href: string; at: Date };

export const NEEDS_YOU_MAX = 50;
const DAY_MS = 86_400_000;
const REPLY_AFTER_DAYS = 3;
const FAILED_RUN_DAYS = 7;
const ERROR_SHOWN = 120;

/**
 * What waits on the owner (at most NEEDS_YOU_MAX, newest first): live cases he has not scored, gate-flagged cases he
 * has not yet kept or killed (no stage event), prospects emailed more than 3 days ago with no event since, and runs
 * that failed in the last 7 days.
 */
export async function needsYou(db: Db, now: Date): Promise<NeedsYouItem[]> {
  const replyBefore = new Date(now.getTime() - REPLY_AFTER_DAYS * DAY_MS);
  const failedSince = new Date(now.getTime() - FAILED_RUN_DAYS * DAY_MS);
  const ownerScore = db.select({ one: sql`1` }).from(scores).where(and(eq(scores.caseId, cases.id), eq(scores.by, 'owner')));
  const anyEvent = db.select({ one: sql`1` }).from(stageEvents).where(eq(stageEvents.caseId, cases.id));
  const lastEvent = max(outreachEvents.at);

  const [unscored, advisory, replies, failed] = await Promise.all([
    db.select({ slug: cases.slug, title: cases.title, at: cases.createdAt }).from(cases)
      .where(and(ne(cases.stage, 'killed'), notExists(ownerScore)))
      .orderBy(desc(cases.createdAt)).limit(NEEDS_YOU_MAX),
    // gateAdvisory is written as `summary.gateFlags.length > 0` by deep-case.
    db.select({ slug: cases.slug, title: cases.title, at: cases.createdAt }).from(cases)
      .where(and(eq(cases.gateAdvisory, true), ne(cases.stage, 'killed'), notExists(anyEvent)))
      .orderBy(desc(cases.createdAt)).limit(NEEDS_YOU_MAX),
    db.select({ name: prospects.name, slug: cases.slug, title: cases.title, at: lastEvent }).from(prospects)
      .innerJoin(cases, eq(cases.id, prospects.caseId))
      .innerJoin(outreachEvents, eq(outreachEvents.prospectId, prospects.id))
      .where(eq(prospects.status, 'sent'))
      .groupBy(prospects.id, prospects.name, cases.slug, cases.title)
      .having(lt(lastEvent, replyBefore))
      .orderBy(desc(lastEvent)).limit(NEEDS_YOU_MAX),
    db.select({ id: runs.id, stage: runs.currentStage, error: runs.error, finishedAt: runs.finishedAt, createdAt: runs.createdAt }).from(runs)
      .where(and(eq(runs.status, 'failed'), or(gte(runs.finishedAt, failedSince), and(isNull(runs.finishedAt), gte(runs.createdAt, failedSince)))))
      .orderBy(desc(runs.createdAt)).limit(NEEDS_YOU_MAX),
  ]);

  const items: NeedsYouItem[] = [
    ...unscored.map((c) => ({ kind: 'score' as const, label: `Score “${c.title}”`, href: `/cases/${c.slug}?tab=score`, at: c.at })),
    ...advisory.map((c) => ({ kind: 'advisory' as const, label: `Gate flags on “${c.title}”: keep or kill?`, href: `/cases/${c.slug}`, at: c.at })),
    ...replies.map((p) => ({
      kind: 'reply' as const, label: `Check your inbox for ${p.name} (“${p.title}”) and log the reply`, href: `/cases/${p.slug}?tab=validate`,
      at: p.at ?? now,
    })),
    ...failed.map((r) => ({
      kind: 'failed_run' as const,
      // D2-R1: scrub first (legacy rows were stored unscrubbed), then cut.
      label: `Run failed${r.stage ? ` at ${r.stage}` : ''}: ${scrubSecrets(r.error ?? 'unknown error').slice(0, ERROR_SHOWN)}`,
      href: '/runs',
      at: r.finishedAt ?? r.createdAt,
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, NEEDS_YOU_MAX);
}
