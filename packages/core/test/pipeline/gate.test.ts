import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { gateVerdicts, ideas, signals } from '../../src/db/schema';
import { StructuredOutputError } from '../../src/llm/router';
import { gate } from '../../src/pipeline/gate';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const deps = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;

const CHECKS = ['generic', 'regulation', 'control', 'autonomy', 'reachability'] as const;
const verdicts = (omit?: string) => ({
  verdicts: CHECKS.filter((c) => c !== omit).map((check) => ({ check, pass: true, reasoning: `${check} ok`, sourceUrls: [] as string[] })),
});
const research = { text: 'Acme does this for $50/mo', sources: [{ url: 'https://acme.example/pricing', title: 'Acme' }] };

async function twoHostIdea(db: Awaited<ReturnType<typeof testDb>>, runId: string, origin: 'generated' | 'owner') {
  const urls = ['https://www.a.com/x', 'https://a.com/y', 'https://b.org/z'];
  const sigs = await db.insert(signals).values(urls.map((url, i) => ({
    marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `h${origin}${i}`,
  }))).returning({ id: signals.id });
  return insertIdea(db, runId, { origin, signalIds: sigs.map((s) => s.id) });
}

describe('gate', () => {
  it('kills a generated idea with too few independent sources', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 3 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out).toEqual({ passed: [], advisory: [] });
    expect((await getIdea(db, idea.id)).status).toBe('gated_out');
    const rows = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.model === 'gpt-6-sol')).toHaveLength(5);
    const ev = rows.find((r) => r.check === 'evidence')!;
    expect(ev.pass).toBe(false);
    expect(ev.model).toBe('rule');
    expect(ev.reasoning).toBe('2 independent sources: a.com, b.org');
  });

  it('keeps an owner idea advanced and flags it as advisory', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', minSignals: 3 }));
    const idea = await twoHostIdea(db, run.id, 'owner');
    await db.update(ideas).set({ status: 'advanced' }).where(eq(ideas.id, idea.id));
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out.passed).toEqual([idea.id]);
    expect(out.advisory).toEqual([{ ideaId: idea.id, failedChecks: ['evidence'] }]);
    expect((await getIdea(db, idea.id)).status).toBe('advanced');
  });

  it('propagates StructuredOutputError when the judge omits a check', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id);
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts('autonomy')] } });
    await expect(gate(deps(db, router), run, { ideaIds: [idea.id] })).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('is idempotent: running twice leaves exactly 6 verdict rows', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    const router = fakeRouter({ research: { competitors: [research, research] }, structured: { gate: [verdicts(), verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const rows = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
    expect(rows).toHaveLength(6);
  });

  it('excludes IP and dotless hosts from independent sources', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const urls = ['http://1.2.3.4/x', 'http://localhost/y', 'http://[::1]/z', 'https://www.example.com/b'];
    const sigs = await db.insert(signals).values(urls.map((url, i) => ({
      marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `hip${i}`,
    }))).returning({ id: signals.id });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id) });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const ev = (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    expect(ev.reasoning).toBe('1 independent sources: example.com');
  });

  it('counts independent sources by registrable domain and excludes bad urls', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const urls = ['https://news.example.com/a', 'https://www.example.com/b', 'not a url', 'ftp://x.com/f'];
    const sigs = await db.insert(signals).values(urls.map((url, i) => ({
      marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `hd${i}`,
    }))).returning({ id: signals.id });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id) });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const ev = (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    expect(ev.reasoning).toBe('1 independent sources: example.com');
  });

  it('makes no LLM calls for empty input', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const router = fakeRouter({});
    expect(await gate(deps(db, router), run, { ideaIds: [] })).toEqual({ passed: [], advisory: [] });
    expect(router.calls).toHaveLength(0);
  });
});
