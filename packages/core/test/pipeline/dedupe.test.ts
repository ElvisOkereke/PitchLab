import { describe, expect, it } from 'vitest';
import { dedupe } from '../../src/pipeline/dedupe';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

async function setup() {
  const db = await testDb();
  const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const pastIdea = await insertIdea(db, past.id, { embedding: unit(0), status: 'gated_out' });
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  return { db, run, pastIdea };
}

const deps = (db: unknown, router: unknown, log: (m: string) => void = () => {}) => ({ db, router, log }) as unknown as StageDeps;

describe('dedupe', () => {
  it('marks a near-copy of a past killed idea as duplicate', async () => {
    const { db, run, pastIdea } = await setup();
    const fresh = await insertIdea(db, run.id, {});
    const dup = await insertIdea(db, run.id, {});
    const router = fakeRouter({ embed: () => [unit(1), unit(0)] });
    const out = await dedupe(deps(db, router), run, { ideaIds: [fresh.id, dup.id] });
    expect(out.ideaIds).toEqual([fresh.id]);
    const row = await getIdea(db, dup.id);
    expect(row.status).toBe('duplicate');
    expect(row.duplicateOf).toBe(pastIdea.id);
    expect((await getIdea(db, fresh.id)).embedding).toEqual(unit(1));
    expect(router.calls.filter((c) => c.kind === 'embed')).toHaveLength(1);
  });

  it('never drops an owner idea as duplicate, only logs', async () => {
    const { db, run } = await setup();
    const owner = await insertIdea(db, run.id, { origin: 'owner' });
    const logs: string[] = [];
    const router = fakeRouter({ embed: () => [unit(0)] });
    const out = await dedupe(deps(db, router, (m) => logs.push(m)), run, { ideaIds: [owner.id] });
    expect(out.ideaIds).toEqual([owner.id]);
    expect((await getIdea(db, owner.id)).status).toBe('candidate');
    expect(logs.some((l) => l.includes('similarity 1.000'))).toBe(true);
  });

  it('dedupes within the same run, keeping the first', async () => {
    const { db, run } = await setup();
    const a = await insertIdea(db, run.id, {});
    const b = await insertIdea(db, run.id, {});
    const router = fakeRouter({ embed: () => [unit(2), unit(2)] });
    const out = await dedupe(deps(db, router), run, { ideaIds: [a.id, b.id] });
    expect(out.ideaIds).toEqual([a.id]);
    expect((await getIdea(db, b.id)).duplicateOf).toBe(a.id);
  });

  it('returns empty without embedding for empty input', async () => {
    const { db, run } = await setup();
    const router = fakeRouter({});
    expect(await dedupe(deps(db, router), run, { ideaIds: [] })).toEqual({ ideaIds: [] });
    expect(router.calls).toHaveLength(0);
  });
});
