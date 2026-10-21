import { beforeEach, describe, expect, it } from 'vitest';
import type { CaseSections } from '../../src/case/schema';
import type { Db } from '../../src/db/client';
import { gateVerdicts, outreachEvents, prospects, scores } from '../../src/db/schema';
import { BOARD_LIMIT, keyMetric, listBoard, listGateKills } from '../../src/dashboard/board';
import { defaultRunConfig } from '../../src/pipeline/types';
import { EXAMPLE_SLUG, ensureExample } from '../../src/example/example';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
let runId: string;

const withRoi = (roiMultiple: number | null) =>
  ({ summary: { oneLiner: 'o' }, numbers: { results: { buyer: { roiMultiple } } } }) as unknown as CaseSections;

async function addCase(o: { slug: string; stage?: 'new' | 'validating' | 'pilot' | 'live' | 'killed'; lensId?: string; roi?: number | null; ai?: number[]; owner?: number }) {
  const idea = await insertIdea(db, runId, { lensId: o.lensId ?? 'aggregator' });
  const c = await insertCase(db, idea.id, { slug: o.slug, title: `T ${o.slug}`, stage: o.stage ?? 'new', sections: withRoi(o.roi ?? null) });
  const crit = ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach'] as const;
  if (o.ai) {
    await db.insert(scores).values(o.ai.map((value, i) => ({ caseId: c.id, criterion: crit[i]!, value, note: '', by: 'ai' as const, model: 'm' })));
  }
  if (o.owner) await db.insert(scores).values({ caseId: c.id, criterion: 'gut', value: o.owner, note: '', by: 'owner' });
  return c;
}

beforeEach(async () => {
  db = await testDb();
  runId = (await insertRun(db, defaultRunConfig({ seedType: 'open' }))).id;
});

describe('board', () => {
  it('board groups by stage, counts honour filters, cards carry metric', async () => {
    await addCase({ slug: 'a', roi: 1.07, ai: [4, 4, 4, 4, 4, 4, 4], owner: 5 });
    await addCase({ slug: 'b', ai: [3, 3, 3, 3, 3, 3, 3] });
    await addCase({ slug: 'c', stage: 'validating', ai: [5, 5, 5, 5, 5, 5, 5] });
    await addCase({ slug: 'd', stage: 'killed' });
    await addCase({ slug: 'e', lensId: 'money-leak', ai: [5, 5, 5, 5, 5, 5, 5] });

    const all = await listBoard(db, {});
    expect(all.counts).toEqual({ new: 3, validating: 1, pilot: 0, live: 0, killed: 1 });

    const b = await listBoard(db, { lensId: 'aggregator' });
    expect(b.counts).toEqual({ new: 2, validating: 1, pilot: 0, live: 0, killed: 1 });
    const a = b.columns.new.find((x) => x.slug === 'a')!;
    expect(a).toMatchObject({ title: 'T a', stage: 'new', aiScore: 4, ownerScore: 5, metric: 'ROI 1.07×' });
    expect(b.columns.new.find((x) => x.slug === 'b')).toMatchObject({ aiScore: 3, ownerScore: null, metric: 'ROI n/a' });
    expect(b.columns.killed[0]!.aiScore).toBeNull();

    const hi = await listBoard(db, { minAi: 3.5 });
    expect(hi.counts).toEqual({ new: 2, validating: 1, pilot: 0, live: 0, killed: 0 });
    expect(hi.columns.new.map((x) => x.slug).sort()).toEqual(['a', 'e']);
  });

  it('newest-updated cards come first within a column', async () => {
    const first = await addCase({ slug: 'old' });
    await addCase({ slug: 'young' });
    void first;
    const b = await listBoard(db, {});
    expect(b.columns.new.map((x) => x.slug)).toEqual(['young', 'old']);
    expect(BOARD_LIMIT).toBe(200);
  });

  it('shows outreach progress once a case has prospects', async () => {
    const c = await addCase({ slug: 'p', roi: 2 });
    const [p1, p2] = await db.insert(prospects).values([
      { caseId: c.id, name: 'A', website: 'https://a.test', domain: 'a.test', location: 'x', fitReason: 'f', source: 'manual' },
      { caseId: c.id, name: 'B', website: 'https://b.test', domain: 'b.test', location: 'x', fitReason: 'f', source: 'manual' },
    ]).returning();
    await db.insert(outreachEvents).values([{ prospectId: p1!.id, type: 'sent' }, { prospectId: p1!.id, type: 'sent' }, { prospectId: p2!.id, type: 'note', note: 'n' }]);
    const b = await listBoard(db, {});
    expect(b.columns.new[0]!.metric).toBe('1/2 emailed');
  });

  it('keyMetric prefers outreach progress', () => {
    expect(keyMetric({ roiMultiple: 2, outreach: { sent: 12, prospects: 50 } })).toBe('12/50 emailed');
    expect(keyMetric({ roiMultiple: 1.07, outreach: { sent: 0, prospects: 0 } })).toBe('ROI 1.07×');
    expect(keyMetric({ roiMultiple: 1.23456 })).toBe('ROI 1.23×');
    expect(keyMetric({ roiMultiple: null })).toBe('ROI n/a');
  });

  it('listGateKills returns failed checks with reasons, newest first', async () => {
    const older = await insertIdea(db, runId, { title: 'Older', status: 'gated_out', createdAt: new Date('2026-10-01T00:00:00Z') });
    const newer = await insertIdea(db, runId, { title: 'Newer', oneLiner: 'nl', status: 'gated_out', createdAt: new Date('2026-10-02T00:00:00Z') });
    await insertIdea(db, runId, { title: 'Advanced', status: 'advanced' });
    const v = (ideaId: string, check: 'generic' | 'control', pass: boolean, reasoning: string, s: number) =>
      ({ ideaId, check, pass, reasoning, model: 'm', promptVersion: 'p', createdAt: new Date(Date.UTC(2026, 9, 3, 0, 0, s)) });
    await db.insert(gateVerdicts).values([
      v(newer.id, 'generic', false, 'too generic (old)', 0), v(newer.id, 'generic', false, 'too generic', 1),
      v(newer.id, 'control', true, 'fine', 0),
      v(older.id, 'control', false, 'needs platform access', 0),
      v(older.id, 'generic', false, 'was generic', 0), v(older.id, 'generic', true, 'now fine', 1),
    ]);
    const kills = await listGateKills(db);
    expect(kills.map((k) => k.title)).toEqual(['Newer', 'Older']);
    expect(kills[0]).toMatchObject({ ideaId: newer.id, oneLiner: 'nl', failed: [{ check: 'generic', reasoning: 'too generic' }] });
    expect(kills[1]!.failed).toEqual([{ check: 'control', reasoning: 'needs platform access' }]);
    expect(await listGateKills(db, 1)).toHaveLength(1);
  });
});

describe('example on the board', () => {
  it('shows the example card flagged, real cards not', async () => {
    await addCase({ slug: 'real' });
    await ensureExample(db);
    const cards = Object.values((await listBoard(db, {})).columns).flat();
    expect(cards.find((c) => c.slug === EXAMPLE_SLUG)?.isExample).toBe(true);
    expect(cards.find((c) => c.slug === 'real')?.isExample).toBe(false);
  });
});
