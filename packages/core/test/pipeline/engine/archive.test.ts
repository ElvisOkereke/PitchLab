import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { lenses, sketches } from '../../../src/db/schema';
import { archive, buyerKind, cellOf } from '../../../src/pipeline/engine/archive';
import { defaultRunConfig } from '../../../src/pipeline/types';
import { fetchPage } from '../../../src/tools/fetch-page';
import { insertCase, insertIdea, insertRun, testDb } from '../../helpers/db';
import { fakeRouter } from '../../helpers/fake-router';

const at = (deg: number) => {
  const v = Array<number>(1536).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};
/** Angle whose cosine to at(0) is `c`. */
const deg = (c: number) => (Math.acos(c) * 180) / Math.PI;
const cfg = () => defaultRunConfig({ seedType: 'lens', lensIds: ['l1'] });

const row = (runId: string, i: number, o: Partial<typeof sketches.$inferInsert> = {}): typeof sketches.$inferInsert => ({
  runId, lensId: 'l1', title: `S${i}`, buyer: 'Landlords', problem: 'p', howItEarns: 'h', businessModel: 'subscription',
  edge: 'e', edgeKind: 'workflow', whyNotTrivial: 'w', earnOrSave: 'earn', signalIds: [], libraryItemIds: [], status: 'kept', ...o,
});

/** `angles[i]` is the embedding angle of sketch i (the embed mock returns them in input order). */
async function setup(angles: number[], rows: Partial<typeof sketches.$inferInsert>[] = []) {
  const db = await testDb();
  const run = await insertRun(db, cfg());
  await db.insert(lenses).values({ id: 'l1', name: 'L', pattern: 'p', promptHint: 'h' });
  const ids = (await db.insert(sketches).values(angles.map((_, i) => row(run.id, i, rows[i]))).returning({ id: sketches.id })).map((r) => r.id);
  const router = fakeRouter({ embed: (t) => t.map((_, i) => at(angles[i]!)) });
  const logs: string[] = [];
  const deps = { db, router, sources: [], fetchPage, log: (m: string) => { logs.push(m); } };
  const other = await insertRun(db, cfg());
  return { db, run, ids, router, deps, other, logs };
}
const statusOf = async (db: Awaited<ReturnType<typeof testDb>>, id: string) =>
  (await db.select().from(sketches).where(eq(sketches.id, id)))[0]!;

describe('buyerKind and cellOf', () => {
  it('maps the buyer and lens audience', () => {
    expect(buyerKind('Anyone', 'consumer')).toBe('consumer');
    expect(buyerKind('Freelance designers', 'business')).toBe('prosumer');
    expect(buyerKind('YouTube creators', 'any')).toBe('prosumer');
    expect(buyerKind('Solo accountants', 'business')).toBe('prosumer');
    expect(buyerKind('independent landlords', 'business')).toBe('prosumer');
    expect(buyerKind('Small team agencies', 'business')).toBe('prosumer');
    expect(buyerKind('Mid-size logistics firms', 'business')).toBe('business');
  });
  it('joins the cell', () => {
    expect(cellOf({ buyerKind: 'business', edgeKind: 'data', businessModel: 'saas' })).toBe('business|data|saas');
    expect(cellOf({ buyerKind: 'consumer', edgeKind: 'none', businessModel: null })).toBe('consumer|none|none');
  });
});

describe('archive', () => {
  it('marks duplicate at 0.86 to an earlier idea and keeps at 0.84', async () => {
    const t = await setup([deg(0.86), deg(0.84)]);
    await insertIdea(t.db, t.other.id, { embedding: at(0) });
    const out = await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('duplicate');
    expect((await statusOf(t.db, t.ids[1]!)).status).toBe('kept');
    expect(out.sketchIds).toEqual([t.ids[1]]);
  });

  it('ignores ideas of its own run (a resume from archive) but not those of another run', async () => {
    const t = await setup([0]);
    await insertIdea(t.db, t.run.id, { embedding: at(0) });
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('kept');
    await insertIdea(t.db, t.other.id, { embedding: at(0) });
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('duplicate');
  });

  it('ignores own-run gate-killed ideas and killed cases', async () => {
    const t = await setup([0]);
    await insertIdea(t.db, t.run.id, { embedding: at(0), status: 'gated_out' });
    const idea = await insertIdea(t.db, t.run.id, { embedding: at(0) });
    await insertCase(t.db, idea.id, { stage: 'killed' });
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('kept');
  });

  it('marks duplicate against an earlier run sketch', async () => {
    const t = await setup([deg(0.9)]);
    await t.db.insert(sketches).values(row(t.other.id, 9, { embedding: at(0) }));
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('duplicate');
  });

  it('marks near_killed at 0.76 to a gate-killed idea or an owner-killed case', async () => {
    const t = await setup([deg(0.76), deg(0.76), deg(0.7)]);
    await insertIdea(t.db, t.other.id, { embedding: at(0), status: 'gated_out' });
    const out = await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('near_killed');
    expect((await statusOf(t.db, t.ids[2]!)).status).toBe('kept');
    expect(out.sketchIds).toContain(t.ids[2]);

    const u = await setup([deg(0.76)]);
    const idea = await insertIdea(u.db, u.other.id, { embedding: at(0), status: 'candidate' });
    await insertCase(u.db, idea.id, { stage: 'killed' });
    await archive(u.deps, u.run, { sketchIds: u.ids });
    expect((await statusOf(u.db, u.ids[0]!)).status).toBe('near_killed');
  });

  it('does not treat a live case as killed', async () => {
    const t = await setup([deg(0.76)]);
    const idea = await insertIdea(t.db, t.other.id, { embedding: at(0) });
    await insertCase(t.db, idea.id, { stage: 'live' });
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).status).toBe('kept');
  });

  it('keeps the first of within-run twins', async () => {
    const t = await setup([0, 1, 100]);
    const out = await archive(t.deps, t.run, { sketchIds: t.ids });
    expect(out.sketchIds).toEqual([t.ids[0], t.ids[2]]);
    expect((await statusOf(t.db, t.ids[1]!)).status).toBe('duplicate');
  });

  it('stores cell and embedding, and reports uniqueShare and cells', async () => {
    const t = await setup([0, 40, 80, 81], [{}, { buyer: 'Freelance writers' }, { edgeKind: 'data' }, {}]);
    const out = await archive(t.deps, t.run, { sketchIds: t.ids, signalIds: ['x'], harvestExtra: 1 });
    // Sketch 3 is within 1 degree of sketch 2 (the others are 40 apart): a twin.
    expect(out.sketchIds).toEqual([t.ids[0], t.ids[1], t.ids[2]]);
    expect(out.uniqueShare).toBeCloseTo(0.75);
    expect(out.cells).toBe(3);
    expect(out.harvestExtra).toBe(1);
    expect(out.signalIds).toEqual(['x']);
    const s = await statusOf(t.db, t.ids[1]!);
    expect(s.cell).toBe('prosumer|workflow|subscription');
    expect(s.embedding).not.toBeNull();
    expect(t.router.calls.filter((c) => c.kind === 'embed')).toHaveLength(1);
  });

  it('uses the lens audience for consumer sketches', async () => {
    const t = await setup([0]);
    await t.db.update(lenses).set({ audience: 'consumer' }).where(eq(lenses.id, 'l1'));
    await archive(t.deps, t.run, { sketchIds: t.ids });
    expect((await statusOf(t.db, t.ids[0]!)).cell).toBe('consumer|workflow|subscription');
  });

  it('ends quietly when everything is a duplicate', async () => {
    const t = await setup([0, 1]);
    await insertIdea(t.db, t.other.id, { embedding: at(0) });
    const out = await archive(t.deps, t.run, { sketchIds: t.ids });
    expect(out.sketchIds).toEqual([]);
    expect(out.uniqueShare).toBe(0);
    expect(out.cells).toBe(0);
  });

  it('handles an empty input without embedding', async () => {
    const t = await setup([0]);
    const out = await archive(t.deps, t.run, { sketchIds: [] });
    expect(out.sketchIds).toEqual([]);
    expect(t.router.calls).toHaveLength(0);
  });
});
