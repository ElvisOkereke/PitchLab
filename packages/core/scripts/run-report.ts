// Read-only summary of a run from the local DB: cost, LLM call errors (429s/retries), idea funnel,
// gate kill reasons, cases with AI scores, and claim verification stats.
// Usage (from packages/core, with no other process holding the PGlite DB):
//   npx tsx scripts/run-report.ts [runId]       (defaults to the most recent run)
// DATABASE_URL defaults to pglite://../../.data/pglite (the repo-root DB the CLI uses).
import { resolve } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { cases, claims, gateVerdicts, ideas, llmCalls, runs, runStages, scores } from '../src/db/schema';

const url = process.env.DATABASE_URL?.startsWith('pglite://') && !process.env.DATABASE_URL.includes('memory')
  ? `pglite://${resolve('../..', process.env.DATABASE_URL.slice('pglite://'.length))}`
  : process.env.DATABASE_URL || `pglite://${resolve('../../.data/pglite')}`;
const db = await createDb(url);

const runId = process.argv[2]
  ?? (await db.select({ id: runs.id }).from(runs).orderBy(desc(runs.createdAt)).limit(1))[0]?.id;
if (!runId) {
  console.log('No runs.');
  process.exit(0);
}
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
if (!run) {
  console.log(`Run not found: ${runId}`);
  process.exit(1);
}
const minutes = run.startedAt && run.finishedAt
  ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 60000).toFixed(1) : '?';
console.log(`Run ${run.id} seed=${run.config.seedType} status=${run.status} cost=$${Number(run.costUsd).toFixed(4)} duration=${minutes}min`);
if (run.error) console.log(`  error: ${run.error}`);

const stages = await db.select().from(runStages).where(eq(runStages.runId, runId)).orderBy(runStages.startedAt);
for (const s of stages) {
  const secs = s.startedAt && s.finishedAt ? ((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000).toFixed(0) : '?';
  console.log(`  stage ${s.stage.padEnd(8)} ${s.status} ${secs}s`);
}

const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
const byStage = new Map<string, { n: number; failed: number; cost: number; model: string }>();
for (const c of calls) {
  const key = `${c.stage}`;
  const e = byStage.get(key) ?? { n: 0, failed: 0, cost: 0, model: c.model };
  e.n++;
  if (!c.ok) e.failed++;
  e.cost += Number(c.costUsd);
  byStage.set(key, e);
}
console.log(`\nLLM calls: ${calls.length} (failed attempts ${calls.filter((c) => !c.ok).length})`);
for (const [stage, e] of byStage) {
  console.log(`  ${stage.padEnd(12)} ${e.model.padEnd(22)} calls=${e.n} failed=${e.failed} cost=$${e.cost.toFixed(4)}`);
}
const errors = new Map<string, number>();
for (const c of calls.filter((c) => !c.ok)) {
  const msg = (c.error ?? '').slice(0, 160);
  errors.set(`${c.stage}: ${msg}`, (errors.get(`${c.stage}: ${msg}`) ?? 0) + 1);
}
for (const [msg, n] of errors) console.log(`  x${n} ${msg}`);
console.log(`  429s: ${calls.filter((c) => (c.error ?? '').includes('429')).length}`);

const ideaRows = await db.select().from(ideas).where(eq(ideas.runId, runId));
const statusCount = new Map<string, number>();
for (const i of ideaRows) statusCount.set(i.status, (statusCount.get(i.status) ?? 0) + 1);
console.log(`\nIdeas: ${ideaRows.length} ${JSON.stringify(Object.fromEntries(statusCount))}`);
const verdicts = ideaRows.length
  ? await db.select().from(gateVerdicts).where(inArray(gateVerdicts.ideaId, ideaRows.map((i) => i.id))) : [];
for (const i of ideaRows) {
  const failed = verdicts.filter((v) => v.ideaId === i.id && !v.pass);
  const total = i.screenTotal === null ? '-' : i.screenTotal.toFixed(2);
  console.log(`  [${i.status}] ${i.title} (screen ${total})`);
  for (const v of failed) console.log(`      gate FAIL ${v.check}: ${v.reasoning.slice(0, 220).replace(/\s+/g, ' ')}`);
}

const caseRows = ideaRows.length
  ? await db.select().from(cases).where(inArray(cases.ideaId, ideaRows.map((i) => i.id))) : [];
for (const k of caseRows) {
  console.log(`\nCase ${k.slug}: ${k.title} (advisory=${k.gateAdvisory}, model=${k.model})`);
  const s = await db.select().from(scores).where(and(eq(scores.caseId, k.id), eq(scores.by, 'ai')));
  if (s.length) {
    const avg = s.reduce((a, r) => a + r.value, 0) / s.length;
    console.log(`  AI scores: ${s.map((r) => `${r.criterion}=${r.value}`).join(' ')} avg=${avg.toFixed(2)}`);
  }
  const cl = await db.select().from(claims).where(eq(claims.caseId, k.id));
  const v = new Map<string, number>();
  for (const c of cl) v.set(c.verified, (v.get(c.verified) ?? 0) + 1);
  console.log(`  claims: ${cl.length} ${JSON.stringify(Object.fromEntries(v))}`);
  if (process.env.SHOW_CLAIMS) {
    for (const c of cl) console.log(`    [${c.verified} ${c.confidence ?? '-'}] ${c.section}: ${c.sourceUrl}`);
  }
}
process.exit(0);
