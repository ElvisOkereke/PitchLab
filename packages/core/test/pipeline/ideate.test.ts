import { describe, expect, it } from 'vitest';
import { ideas, lenses, signals } from '../../src/db/schema';
import { ideate } from '../../src/pipeline/ideate';
import { defaultRunConfig, type RunConfig } from '../../src/pipeline/types';
import { fetchPage } from '../../src/tools/fetch-page';
import { insertRun, testDb } from '../helpers/db';
import { fakeRouter, type FakeScript } from '../helpers/fake-router';

const mk = (n: number, urls: string[]) => ({
  ideas: Array.from({ length: n }, (_, i) => ({
    title: `T${i}`, oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalUrls: urls,
  })),
});

async function setup(config: RunConfig, script: FakeScript) {
  const db = await testDb();
  const run = await insertRun(db, config);
  const rows = await db.insert(signals).values(['a', 'b'].map((k) => ({
    runId: run.id, marketId: 'ca-us', source: 'hn', url: `https://x.test/${k}`, title: k,
    quote: `quote ${k}`, quoteHash: `h${k}`,
  }))).returning({ id: signals.id, url: signals.url });
  const router = fakeRouter(script);
  return { db, run, rows, router, deps: { db, router, sources: [], fetchPage, log: () => {} } };
}

describe('ideate', () => {
  it('one call per lens, ceil(ideaCount/lenses) ideas each, unknown urls dropped', async () => {
    const config = defaultRunConfig({ seedType: 'lens', lensIds: ['tl1', 'tl2'], ideaCount: 4 });
    const t = await setup(config, {
      structured: { ideate: [
        mk(2, ['https://x.test/a', 'https://unknown.test/z']),
        mk(3, ['https://x.test/b']), // one too many: truncated to 2
      ] },
    });
    await t.db.insert(lenses).values([
      { id: 'tl1', name: 'L1', pattern: 'pat1', promptHint: 'hint1' },
      { id: 'tl2', name: 'L2', pattern: 'pat2', promptHint: 'hint2' },
    ]);
    const out = await ideate(t.deps, t.run, { signalIds: t.rows.map((r) => r.id) });
    expect(t.router.calls).toHaveLength(2);
    expect(t.router.calls[0]!.prompt).toContain('pat1');
    expect(t.router.calls[0]!.prompt).toContain('exactly 2 ideas');
    expect(t.router.calls[0]!.prompt).toContain('<signals>');
    expect(out.ideaIds).toHaveLength(4);
    const stored = await t.db.select().from(ideas);
    expect(stored.filter((i) => i.lensId === 'tl1')).toHaveLength(2);
    expect(stored.filter((i) => i.lensId === 'tl2')).toHaveLength(2);
    expect(stored.every((i) => i.origin === 'generated' && i.status === 'candidate')).toBe(true);
    expect(stored.find((i) => i.lensId === 'tl1')!.signalIds).toEqual([t.rows[0]!.id]);
  });

  it('caps signals at 40 in input order', async () => {
    const config = defaultRunConfig({ seedType: 'lens', lensIds: ['tl1'], ideaCount: 1 });
    const t = await setup(config, { structured: { ideate: [mk(1, [])] } });
    await t.db.insert(lenses).values({ id: 'tl1', name: 'L1', pattern: 'pat1', promptHint: 'hint1' });
    const extra = await t.db.insert(signals).values(Array.from({ length: 45 }, (_, i) => ({
      runId: t.run.id, marketId: 'ca-us', source: 'hn', url: `https://m.test/${i}`, title: 't',
      quote: `q${i}`, quoteHash: `m${i}`,
    }))).returning({ id: signals.id, url: signals.url });
    // returning order matches insert order
    await ideate(t.deps, t.run, { signalIds: extra.map((r) => r.id) });
    const p = t.router.calls[0]!.prompt;
    expect(p).toContain('https://m.test/39');
    expect(p).not.toContain('https://m.test/40');
  });

  it('owner seed inserts exactly one owner idea and passes the text verbatim', async () => {
    const text = 'Lead-flow verification: submit test leads to client sites and confirm they arrive.';
    const config = defaultRunConfig({ seedType: 'idea', ideaText: text });
    const t = await setup(config, {
      structured: { ideate: [{ title: 'Lead-flow', oneLiner: 'o', buyer: 'agencies', problem: 'p', solution: 's' }] },
    });
    const ids = t.rows.map((r) => r.id);
    const out = await ideate(t.deps, t.run, { signalIds: ids });
    expect(t.router.calls).toHaveLength(1);
    expect(t.router.calls[0]!.prompt).toContain(text);
    expect(t.router.calls[0]!.prompt).toContain('<idea>');
    const stored = await t.db.select().from(ideas);
    expect(stored).toHaveLength(1);
    expect(out.ideaIds).toEqual([stored[0]!.id]);
    expect(stored[0]).toMatchObject({ origin: 'owner', lensId: null, status: 'candidate' });
    expect(stored[0]!.signalIds).toEqual(ids);
  });

  it('rejects blank owner idea text', async () => {
    const config = defaultRunConfig({ seedType: 'idea', ideaText: '  ' });
    const t = await setup(config, {});
    await expect(ideate(t.deps, t.run, { signalIds: [] })).rejects.toThrow('ideaText is required for idea seeds');
  });

  it('rejects lens ids that match no active lens, naming them', async () => {
    const config = defaultRunConfig({ seedType: 'lens', lensIds: ['nope'] });
    const t = await setup(config, {});
    await expect(ideate(t.deps, t.run, { signalIds: [] })).rejects.toThrow(/nope/);
  });
});
