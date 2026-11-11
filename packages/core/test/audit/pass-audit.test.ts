import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { benchmarkPasses, gateVerdicts, ideaReviews, knowledgeItems, runStages, signals } from '../../src/db/schema';
import { IDEA_REVIEW_VERSION } from '../../src/bench/definitions';
import { computePassAudit, domainOf, gateCheckLabel } from '../../src/audit/pass-audit';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

async function newPass(db: Db, runCount = 1) {
  const runIds: string[] = [];
  for (let i = 0; i < runCount; i++) runIds.push((await insertRun(db, defaultRunConfig({ seedType: 'open' }))).id);
  const [p] = await db.insert(benchmarkPasses).values({ version: 'bench-v2', label: 'bench-v2 #1', kind: 'pass', status: 'complete', runIds }).returning();
  return { passId: p!.id, runIds };
}

let n = 0;
async function sigs(db: Db, runId: string, specs: { host: string; voice?: 'operator' | 'neutral' | 'vendor' | null; source?: string }[]) {
  for (const s of specs) {
    n += 1;
    await db.insert(signals).values({
      runId, marketId: 'ca-us', source: s.source ?? 'web', url: `https://${s.host}/p/${n}`, title: 't', quote: 'q', quoteHash: `ph${n}`,
      voice: s.voice === undefined ? 'operator' : s.voice,
    });
  }
}
const many = (host: string, k: number, voice: 'operator' | 'vendor' = 'operator') => Array.from({ length: k }, () => ({ host, voice }));

describe('computePassAudit', () => {
  it('an empty pass renders zeros and nulls with no flags', async () => {
    const db = await testDb();
    const { passId } = await newPass(db);
    const a = await computePassAudit(db, passId);
    expect(a).toEqual({
      signals: { total: 0, byVoice: {}, bySource: {}, topDomains: [] }, lenses: [], gateKills: {}, dropReasons: {}, demandShare: null, nicheShare: null, flags: [],
    });
  });

  it('unknown or malformed pass ids give the same empty audit', async () => {
    const db = await testDb();
    expect((await computePassAudit(db, 'nope')).flags).toEqual([]);
    expect((await computePassAudit(db, '00000000-0000-4000-8000-000000000000')).signals.total).toBe(0);
  });

  it('counts signals by voice, source and domain', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db, 2);
    await sigs(db, runIds[0]!, [
      { host: 'a.example', voice: 'operator', source: 'reddit' }, { host: 'www.a.example', voice: 'neutral', source: 'reddit' },
      { host: 'b.example', voice: null, source: 'hn' }, { host: 'c.co.uk', voice: 'vendor', source: 'web' },
    ]);
    await sigs(db, runIds[1]!, [{ host: 'a.example', voice: 'operator', source: 'web' }]);
    const a = await computePassAudit(db, passId);
    expect(a.signals.total).toBe(5);
    expect(a.signals.byVoice).toEqual({ operator: 2, neutral: 1, untagged: 1, vendor: 1 });
    expect(a.signals.bySource).toEqual({ reddit: 2, hn: 1, web: 2 });
    expect(a.signals.topDomains[0]).toEqual({ domain: 'a.example', share: 3 / 5 });
    expect(a.signals.topDomains.map((d) => d.domain)).toContain('c.co.uk');
  });

  it('ignores signals of runs outside the pass', async () => {
    const db = await testDb();
    const { passId } = await newPass(db);
    const other = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await sigs(db, other.id, many('x.example', 3));
    expect((await computePassAudit(db, passId)).signals.total).toBe(0);
  });

  it('joins ideas to lenses with screened-in, advanced and case counts', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db);
    const r = runIds[0]!;
    await insertIdea(db, r, { lensId: 'aggregator', status: 'screened_out' });
    await insertIdea(db, r, { lensId: 'aggregator', status: 'gated_out' });
    const adv = await insertIdea(db, r, { lensId: 'aggregator', status: 'advanced' });
    await insertCase(db, adv.id);
    await insertIdea(db, r, { lensId: 'money-leak', status: 'duplicate' });
    await insertIdea(db, r, { lensId: null, status: 'advanced' });
    await insertIdea(db, r, { lensId: 'money-leak', status: 'advanced', origin: 'owner' });
    const a = await computePassAudit(db, passId);
    expect(a.lenses).toEqual([
      { lensId: 'aggregator', ideas: 3, screenedIn: 2, advanced: 1, cases: 1 },
      { lensId: 'money-leak', ideas: 1, screenedIn: 0, advanced: 0, cases: 0 },
    ]);
  });

  it('counts gate kills per failed check on gated-out ideas only', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db);
    const v = (ideaId: string, check: 'generic' | 'control' | 'evidence', pass: boolean) =>
      ({ ideaId, check, pass, reasoning: 'r', model: 'm', promptVersion: 'p' });
    const a1 = await insertIdea(db, runIds[0]!, { status: 'gated_out' });
    const a2 = await insertIdea(db, runIds[0]!, { status: 'gated_out' });
    const ok = await insertIdea(db, runIds[0]!, { status: 'advanced' });
    await db.insert(gateVerdicts).values([
      v(a1.id, 'control', false), v(a1.id, 'generic', false), v(a2.id, 'control', false), v(a2.id, 'generic', true), v(ok.id, 'control', true),
    ]);
    const a = await computePassAudit(db, passId);
    expect(a.gateKills).toEqual({ control: 2, generic: 1 });
  });

  it('sums ideate drop reasons across runs and ignores malformed outputs', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db, 3);
    const stage = (runId: string, output: unknown) => db.insert(runStages).values({ runId, stage: 'ideate', status: 'done', output });
    await stage(runIds[0]!, { dropReasons: { 'too vague': 2, 'no edge': 1 } });
    await stage(runIds[1]!, { dropReasons: { 'too vague': 3, bad: 'x', neg: -1 } });
    await stage(runIds[2]!, null);
    await db.insert(runStages).values({ runId: runIds[0]!, stage: 'gate', status: 'done', output: { dropReasons: { ignored: 9 } } });
    expect((await computePassAudit(db, passId)).dropReasons).toEqual({ 'too vague': 5, 'no edge': 1 });
  });

  it('demandShare is the share of ideas citing a trend, rule change or market, null with no library use', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db);
    expect((await computePassAudit(db, passId)).demandShare).toBeNull();
    const item = async (kind: 'trend' | 'problem', i: number) => (await db.insert(knowledgeItems).values({
      kind, title: `k${i}`, summary: 's', audience: 'business', countries: [], industries: [], facts: {}, contentHash: `pa-${kind}-${i}`,
    }).returning({ id: knowledgeItems.id }))[0]!.id;
    const trend = await item('trend', 1);
    const problem = await item('problem', 2);
    await insertIdea(db, runIds[0]!, { libraryItemIds: [trend] });
    await insertIdea(db, runIds[0]!, { libraryItemIds: [problem, trend] });
    await insertIdea(db, runIds[0]!, { libraryItemIds: [problem] });
    await insertIdea(db, runIds[0]!, { libraryItemIds: [] });
    await insertIdea(db, runIds[0]!);
    expect((await computePassAudit(db, passId)).demandShare).toBe(2 / 4);
  });

  it('nicheShare counts niche >= 4 or scale <= 2 among current-version reviews', async () => {
    const db = await testDb();
    const { passId, runIds } = await newPass(db);
    const rev = async (niche: number, scale: number, promptVersion = IDEA_REVIEW_VERSION) => {
      const i = await insertIdea(db, runIds[0]!);
      await db.insert(ideaReviews).values({ ideaId: i.id, scale, edge: 3, novelty: 3, niche, reasons: {}, model: 'm', promptVersion });
    };
    await rev(4, 5);
    await rev(1, 2);
    await rev(2, 3);
    await rev(5, 1, 'idea-review.v0');
    const a = await computePassAudit(db, passId);
    expect(a.nicheShare).toBe(2 / 3);
  });

  describe('flags', () => {
    it('are plain language naming the number and the limit', async () => {
      const db = await testDb();
      const { passId, runIds } = await newPass(db);
      await sigs(db, runIds[0]!, [...many('wordpress.org', 18), ...Array.from({ length: 82 }, (_, i) => ({ host: `h${i}.example` }))]);
      const a = await computePassAudit(db, passId);
      expect(a.flags).toEqual(['wordpress.org supplied 18% of the evidence (limit 15%)']);
    });

    it('top domain fires above 15% but not at exactly 15%', async () => {
      const db = await testDb();
      const at = await newPass(db);
      await sigs(db, at.runIds[0]!, [...many('a.example', 15), ...Array.from({ length: 85 }, (_, i) => ({ host: `h${i}.example` }))]);
      expect((await computePassAudit(db, at.passId)).flags).toEqual([]);
      const above = await newPass(db);
      await sigs(db, above.runIds[0]!, [...many('a.example', 16), ...Array.from({ length: 84 }, (_, i) => ({ host: `h${i}.example` }))]);
      expect((await computePassAudit(db, above.passId)).flags).toEqual(['a.example supplied 16% of the evidence (limit 15%)']);
    });

    it('vendor voice fires above 40% but not at 40%', async () => {
      const db = await testDb();
      const spread = (k: number, voice: 'operator' | 'vendor') => Array.from({ length: k }, (_, i) => ({ host: `${voice}${i}.example`, voice }));
      const at = await newPass(db);
      await sigs(db, at.runIds[0]!, [...spread(4, 'vendor'), ...spread(6, 'operator')]);
      expect((await computePassAudit(db, at.passId)).flags).toEqual([]);
      const above = await newPass(db);
      await sigs(db, above.runIds[0]!, [...spread(5, 'vendor'), ...spread(6, 'operator')]);
      expect((await computePassAudit(db, above.passId)).flags[0]).toBe('Sellers wrote 45.5% of the evidence (limit 40%)');
    });

    it('one lens fires above 35% of the ideas but not at 35%', async () => {
      const db = await testDb();
      const build = async (top: number) => {
        const { passId, runIds } = await newPass(db);
        for (let i = 0; i < top; i++) await insertIdea(db, runIds[0]!, { lensId: 'aggregator' });
        for (let i = 0; i < 100 - top; i++) await insertIdea(db, runIds[0]!, { lensId: i % 2 ? 'money-leak' : 'silent-failure' });
        return (await computePassAudit(db, passId)).flags;
      };
      expect(await build(35)).toEqual([]);
      expect(await build(36)).toEqual(['The aggregator lens produced 36% of the ideas (limit 35%)']);
    });

    it('one gate check fires above 50% of the killed ideas but not at 50%', async () => {
      const db = await testDb();
      const build = async (control: number) => {
        const { passId, runIds } = await newPass(db);
        for (let i = 0; i < 10; i++) {
          const idea = await insertIdea(db, runIds[0]!, { status: 'gated_out' });
          await db.insert(gateVerdicts).values({ ideaId: idea.id, check: i < control ? 'control' : 'generic', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' });
        }
        return (await computePassAudit(db, passId)).flags;
      };
      expect(await build(5)).toEqual([]);
      expect(await build(6)).toEqual(['The control check failed 60% of the ideas the gate rejected (limit 50%)']);
    });

    it('scale kills are intended filtering and never raise the one-check flag; other checks use readable labels', async () => {
      const db = await testDb();
      const build = async (top: 'scale' | 'reachability' | 'evidence', n: number) => {
        const { passId, runIds } = await newPass(db);
        for (let i = 0; i < 10; i++) {
          const idea = await insertIdea(db, runIds[0]!, { status: 'gated_out' });
          await db.insert(gateVerdicts).values({ ideaId: idea.id, check: i < n ? top : 'generic', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' });
        }
        return computePassAudit(db, passId);
      };
      const scale = await build('scale', 9);
      expect(scale.gateKills).toEqual({ scale: 9, generic: 1 });
      expect(scale.flags).toEqual([]);
      expect((await build('reachability', 7)).flags).toEqual(['The reachability check failed 70% of the ideas the gate rejected (limit 50%)']);
      expect((await build('evidence', 7)).flags).toEqual(['The evidence check failed 70% of the ideas the gate rejected (limit 50%)']);
      expect(gateCheckLabel('scale')).toBe('revenue ceiling');
      expect(gateCheckLabel('generic')).toBe('generic');
    });

    it('a flagged comps verdict (advisory, gate.v7) is never counted as a kill reason', async () => {
      const db = await testDb();
      const { passId, runIds } = await newPass(db);
      for (let i = 0; i < 10; i++) {
        const idea = await insertIdea(db, runIds[0]!, { status: 'gated_out' });
        await db.insert(gateVerdicts).values([
          { ideaId: idea.id, check: 'comps', pass: false, reasoning: 'no comps found', model: 'rule', promptVersion: 'comps-rule.v1' },
          { ideaId: idea.id, check: i < 4 ? 'trivial' : 'generic', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' },
        ]);
      }
      const audit = await computePassAudit(db, passId);
      expect(audit.gateKills).toEqual({ trivial: 4, generic: 6 });
      expect(audit.flags).toEqual(['The generic check failed 60% of the ideas the gate rejected (limit 50%)']);
    });

    it('niche share fires above 30% but not at 30%', async () => {
      const db = await testDb();
      const build = async (niche: number) => {
        const { passId, runIds } = await newPass(db);
        for (let i = 0; i < 10; i++) {
          const idea = await insertIdea(db, runIds[0]!);
          await db.insert(ideaReviews).values({ ideaId: idea.id, scale: 4, edge: 3, novelty: 3, niche: i < niche ? 5 : 1, reasons: {}, model: 'm', promptVersion: IDEA_REVIEW_VERSION });
        }
        return (await computePassAudit(db, passId)).flags;
      };
      expect(await build(3)).toEqual([]);
      expect(await build(4)).toEqual(['The idea reviewer called 40% of the ideas niche or small (limit 30%)']);
    });

    it('a pass with signals but no ideas or gate entrants raises only evidence flags and never divides by zero', async () => {
      const db = await testDb();
      const { passId, runIds } = await newPass(db);
      await sigs(db, runIds[0]!, many('a.example', 10));
      const a = await computePassAudit(db, passId);
      expect(a.flags).toEqual(['a.example supplied 100% of the evidence (limit 15%)']);
      expect(a.lenses).toEqual([]);
      expect(a.gateKills).toEqual({});
      expect(a.nicheShare).toBeNull();
    });

    it('skip a flag when its sample is tiny: under 10 signals, or under 5 ideas, kills or reviews', async () => {
      const db = await testDb();
      const { passId, runIds } = await newPass(db);
      // 9 signals, all one vendor domain.
      await sigs(db, runIds[0]!, many('a.example', 9, 'vendor'));
      // 4 ideas, all one lens, all killed by one check, all reviewed niche.
      for (let i = 0; i < 4; i++) {
        const idea = await insertIdea(db, runIds[0]!, { lensId: 'aggregator', status: 'gated_out' });
        await db.insert(gateVerdicts).values({ ideaId: idea.id, check: 'control', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' });
        await db.insert(ideaReviews).values({ ideaId: idea.id, scale: 1, edge: 3, novelty: 3, niche: 5, reasons: {}, model: 'm', promptVersion: IDEA_REVIEW_VERSION });
      }
      const a = await computePassAudit(db, passId);
      expect(a.flags).toEqual([]);
      // The counts and shares are still reported.
      expect(a.signals.total).toBe(9);
      expect(a.nicheShare).toBe(1);
      // One more of each reaches the minimum and every flag fires.
      await sigs(db, runIds[0]!, many('a.example', 1, 'vendor'));
      const idea = await insertIdea(db, runIds[0]!, { lensId: 'aggregator', status: 'gated_out' });
      await db.insert(gateVerdicts).values({ ideaId: idea.id, check: 'control', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' });
      await db.insert(ideaReviews).values({ ideaId: idea.id, scale: 1, edge: 3, novelty: 3, niche: 5, reasons: {}, model: 'm', promptVersion: IDEA_REVIEW_VERSION });
      expect((await computePassAudit(db, passId)).flags).toHaveLength(5);
    });

    it('the top-domain flag ignores signals whose domain is unknown', async () => {
      const db = await testDb();
      const { passId, runIds } = await newPass(db);
      for (let i = 0; i < 30; i++) {
        await db.insert(signals).values({ runId: runIds[0]!, marketId: 'ca-us', source: 'web', url: `not a url ${i}`, title: 't', quote: 'q', quoteHash: `bad${i}`, voice: 'operator' });
      }
      await sigs(db, runIds[0]!, [...many('b.example', 16), ...Array.from({ length: 54 }, (_, i) => ({ host: `u${i}.example` }))]);
      const a = await computePassAudit(db, passId);
      expect(a.signals.topDomains[0]).toEqual({ domain: 'unknown', share: 0.3 });
      expect(a.flags).toEqual(['b.example supplied 16% of the evidence (limit 15%)']);
    });
  });
});

describe('domainOf', () => {
  it('drops www, keeps registrable-looking names, handles bad urls', () => {
    expect(domainOf('https://www.wordpress.org/support/x')).toBe('wordpress.org');
    expect(domainOf('https://forum.example.co.uk/a')).toBe('example.co.uk');
    expect(domainOf('https://news.ycombinator.com/item?id=1')).toBe('ycombinator.com');
    expect(domainOf('not a url')).toBe('unknown');
  });
});
