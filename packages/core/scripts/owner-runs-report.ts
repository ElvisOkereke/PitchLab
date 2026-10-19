// Read-only detail report for one or more runs: cost by stage, signals, idea, gate verdicts, case scores,
// and claims by section x verification status (non-verified claims listed).
// Usage (from packages/core, no other process holding the PGlite DB):
//   npx tsx scripts/owner-runs-report.ts <runId> [runId...]
// Always opens the repo-root DB (.data/pglite), resolved from this file's location, not cwd.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { cases, claims, dataCalls, gateVerdicts, ideas, llmCalls, runs, scores, signals } from '../src/db/schema';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const db = await createDb(`pglite://${resolve(repoRoot, '.data/pglite')}`);
const one = (s: string | null | undefined, n = 400) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

for (const runId of process.argv.slice(2)) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) { console.log(`Run not found: ${runId}`); continue; }
  const mins = run.startedAt && run.finishedAt ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 60000).toFixed(1) : '?';
  console.log(`\n==== Run ${run.id} status=${run.status} cost=$${Number(run.costUsd).toFixed(4)} ${mins}min`);
  if (run.error) console.log(`  error: ${run.error}`);

  const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
  const by = new Map<string, { n: number; failed: number; cost: number; model: string }>();
  for (const c of calls) {
    const e = by.get(c.stage) ?? { n: 0, failed: 0, cost: 0, model: c.model };
    e.n++; if (!c.ok) e.failed++; e.cost += Number(c.costUsd); by.set(c.stage, e);
  }
  console.log(`  LLM calls ${calls.length}, failed ${calls.filter((c) => !c.ok).length}, 429s ${calls.filter((c) => (c.error ?? '').includes('429')).length}`);
  for (const [s, e] of by) console.log(`    ${s.padEnd(10)} ${e.model.padEnd(22)} n=${e.n} failed=${e.failed} $${e.cost.toFixed(4)}`);
  for (const c of calls.filter((c) => !c.ok)) console.log(`    FAIL ${c.stage}: ${one(c.error, 200)}`);

  const dc = await db.select().from(dataCalls).where(eq(dataCalls.runId, runId));
  const dcBy = new Map<string, { ok: number; bad: number }>();
  for (const d of dc) { const e = dcBy.get(d.provider) ?? { ok: 0, bad: 0 }; d.ok ? e.ok++ : e.bad++; dcBy.set(d.provider, e); }
  console.log(`  data calls: ${JSON.stringify(Object.fromEntries(dcBy))}`);

  const sig = await db.select().from(signals).where(eq(signals.runId, runId));
  const hosts = new Map<string, number>();
  for (const s of sig) { let h = s.source; try { h = new URL(s.url).hostname; } catch { /* keep */ } hosts.set(h, (hosts.get(h) ?? 0) + 1); }
  console.log(`  signals harvested: ${sig.length} ${JSON.stringify(Object.fromEntries(hosts))}`);

  const ideaRows = await db.select().from(ideas).where(eq(ideas.runId, runId));
  for (const i of ideaRows) {
    console.log(`  IDEA [${i.status}] ${i.title} | mechanism=${i.mechanism} buyerType=${i.buyerType} screen=${i.screenTotal} signals=${i.signalIds.length}`);
    console.log(`    screenScores: ${one(JSON.stringify(i.screenScores), 600)}`);
    const v = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, i.id));
    for (const g of v) {
      console.log(`    GATE ${g.check} ${g.pass ? 'pass' : 'FAIL'} (${g.model}): ${one(g.reasoning, 900)}`);
      if (g.sources) console.log(`      sources: ${one(JSON.stringify(g.sources), 700)}`);
    }
    const [k] = await db.select().from(cases).where(eq(cases.ideaId, i.id));
    if (!k) continue;
    console.log(`  CASE ${k.slug}: ${k.title} advisory=${k.gateAdvisory} model=${k.model} prompt=${k.promptVersion}`);
    const sc = await db.select().from(scores).where(and(eq(scores.caseId, k.id), eq(scores.by, 'ai')));
    if (sc.length) console.log(`    AI: ${sc.map((r) => `${r.criterion}=${r.value}`).join(' ')} avg=${(sc.reduce((a, r) => a + r.value, 0) / sc.length).toFixed(2)}`);
    const cl = await db.select().from(claims).where(eq(claims.caseId, k.id));
    const grid = new Map<string, Record<string, number>>();
    for (const c of cl) { const g = grid.get(c.section) ?? {}; g[c.verified] = (g[c.verified] ?? 0) + 1; grid.set(c.section, g); }
    for (const [s, g] of grid) console.log(`    claims ${s.padEnd(18)} ${JSON.stringify(g)}`);
    for (const c of cl.filter((c) => c.verified !== 'verified')) {
      console.log(`    - [${c.verified} ${c.confidence ?? '-'}] ${c.section}: ${one(c.text, 220)} <${c.sourceUrl}> ${c.reviewNote ? `note=${c.reviewNote}` : ''}`);
    }
    const sigClaims = cl.filter((c) => c.section === 'signal');
    for (const c of sigClaims) console.log(`    SIGNAL ${c.verified}: ${c.sourceUrl}`);
  }
  if (ideaRows.length === 0) console.log('  (no ideas)');
  void inArray;
}
process.exit(0);
