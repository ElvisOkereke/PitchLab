import { describe, expect, it } from 'vitest';
import { landingPages, outreachDrafts, outreachEvents, prospects, validationPacks } from '../../src/db/schema';
import { getValidateView } from '../../src/dashboard/validate-view';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

async function setup() {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const kase = await insertCase(db, (await insertIdea(db, run.id)).id);
  return { db, caseId: kase.id };
}

describe('getValidateView', () => {
  it('getValidateView returns empty state when no pack exists and never includes landing html', async () => {
    const { db, caseId } = await setup();
    const v = await getValidateView(db, caseId, { page: 1 });
    expect(v.pack).toBeNull();
    expect(v.checklist).toBeNull();
    expect(v.landing).toBeNull();
    expect(v.prospects).toEqual({ rows: [], total: 0 });
    expect(v.drafts.size).toBe(0);
    expect(v.events).toEqual([]);
    expect(v.counts.prospects).toBe(0);

    const html = '<html><script>alert(1)</script>é</html>';
    await db.insert(landingPages).values({ caseId, slug: 's', html, copy: { headline: 'H' }, publishedUrl: 'https://pages.test/s' });
    const w = await getValidateView(db, caseId, { page: 1 });
    expect(w.landing).toMatchObject({ copy: { headline: 'H' }, publishedUrl: 'https://pages.test/s', htmlBytes: Buffer.byteLength(html) });
    expect(w.landing!.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(w)).not.toContain('<script>');
  });

  it('returns an empty view for a non-uuid case id instead of a database error (D2-R3)', async () => {
    const db = await testDb();
    for (const bad of ['', 'not-a-uuid', "x' or 1=1 --", '123']) {
      const v = await getValidateView(db, bad, { page: 1 });
      expect(v.pack).toBeNull();
      expect(v.prospects).toEqual({ rows: [], total: 0 });
      expect(v.events).toEqual([]);
      expect(v.landing).toBeNull();
      expect(v.checklist).toBeNull();
      expect(v.counts.prospects).toBe(0);
      expect(v.counts.byStatus.sent).toBe(0);
      expect(v.counts.events.sent).toEqual({ events: 0, prospects: 0 });
    }
  });

  it('returns the pack, checklist, prospects with their drafts, latest events and counts', async () => {
    const { db, caseId } = await setup();
    await db.insert(validationPacks).values({ caseId, sections: { not: 'a valid pack' }, model: 'm', promptVersion: 'p' });
    const [a, b] = await db.insert(prospects).values([
      { caseId, name: 'A', website: 'https://a.test', domain: 'a.test', location: 'x', fitReason: 'f', source: 'manual', email: 'a@a.test' },
      { caseId, name: 'B', website: 'https://b.test', domain: 'b.test', location: 'x', fitReason: 'f', source: 'manual' },
    ]).returning();
    await db.insert(outreachDrafts).values([
      { prospectId: a!.id, kind: 'cold', subject: 's1', body: 'b1', model: 'm', promptVersion: 'p' },
      { prospectId: a!.id, kind: 'followup1', subject: 's2', body: 'b2', model: 'm', promptVersion: 'p' },
    ]);
    await db.insert(outreachEvents).values([{ prospectId: a!.id, type: 'sent' }, { prospectId: b!.id, type: 'note', note: 'n' }]);
    const v = await getValidateView(db, caseId, { page: 1 });
    expect(v.pack?.caseId).toBe(caseId);
    expect(v.checklist).toEqual([]); // unreadable legacy pack sections → no gates
    expect(v.prospects.total).toBe(2);
    expect(v.prospects.rows.map((p) => p.name)).toEqual(['A', 'B']);
    expect(v.drafts.get(a!.id)!.map((d) => d.kind)).toEqual(['cold', 'followup1']);
    expect(v.drafts.has(b!.id)).toBe(false);
    expect(v.events).toHaveLength(2);
    expect(v.counts).toMatchObject({ prospects: 2, withEmail: 1 });
  });
});
