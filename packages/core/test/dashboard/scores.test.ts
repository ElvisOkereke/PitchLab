import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { scores } from '../../src/db/schema';
import { OwnerScoresInputSchema, saveOwnerScores } from '../../src/dashboard/scores';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
let caseId: string;

beforeEach(async () => {
  db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  caseId = (await insertCase(db, (await insertIdea(db, run.id)).id)).id;
  await db.insert(scores).values([
    { caseId, criterion: 'pain', value: 4, note: 'ai pain', by: 'ai', model: 'gemini', promptVersion: 'score.v1' },
    { caseId, criterion: 'roi', value: 2, note: 'ai roi', by: 'ai', model: 'gemini', promptVersion: 'score.v1' },
  ]);
});

const rowsBy = (by: 'ai' | 'owner') => db.select().from(scores).where(and(eq(scores.caseId, caseId), eq(scores.by, by)));

describe('owner scores', () => {
  it('saveOwnerScores replaces only the submitted owner criteria in one transaction', async () => {
    const aiRowsBefore = await rowsBy('ai');
    expect(await saveOwnerScores(db, OwnerScoresInputSchema.parse({ caseId, entries: [{ criterion: 'gut', value: 4, note: 'a' }, { criterion: 'pain', value: 3, note: '' }] })))
      .toEqual({ ok: true, saved: 2 });
    expect(await saveOwnerScores(db, OwnerScoresInputSchema.parse({ caseId, entries: [{ criterion: 'gut', value: 5, note: 'b' }] })))
      .toEqual({ ok: true, saved: 1 });
    const ownerRows = await rowsBy('owner');
    expect(ownerRows.map((r) => [r.criterion, r.value])).toEqual(expect.arrayContaining([['gut', 5], ['pain', 3]]));
    expect(ownerRows).toHaveLength(2);
    expect(ownerRows.find((r) => r.criterion === 'gut')).toMatchObject({ note: 'b', model: null, promptVersion: null });
    expect(await rowsBy('ai')).toEqual(aiRowsBefore);
  });

  it('returns not_found for an unknown case and writes nothing', async () => {
    expect(await saveOwnerScores(db, { caseId: randomUUID(), entries: [{ criterion: 'gut', value: 3, note: '' }] })).toEqual({ ok: false, reason: 'not_found' });
    expect(await rowsBy('owner')).toHaveLength(0);
  });

  it('OwnerScoresInputSchema rejects out-of-range values, unknown criteria, duplicates and empty entries', () => {
    const bad = [
      { caseId, entries: [{ criterion: 'gut', value: 6 }] },
      { caseId, entries: [{ criterion: 'gut', value: 0 }] },
      { caseId, entries: [{ criterion: 'gut', value: 2.5 }] },
      { caseId, entries: [{ criterion: 'vibes', value: 3 }] },
      { caseId, entries: [{ criterion: 'gut', value: 3 }, { criterion: 'gut', value: 4 }] },
      { caseId, entries: [] },
      { caseId: 'nope', entries: [{ criterion: 'gut', value: 3 }] },
      { caseId, entries: [{ criterion: 'gut', value: 3, note: 'x'.repeat(1001) }] },
    ];
    for (const b of bad) expect(OwnerScoresInputSchema.safeParse(b).success).toBe(false);
    expect(OwnerScoresInputSchema.parse({ caseId, entries: [{ criterion: 'gut', value: 3 }] }).entries[0]!.note).toBe('');
  });
});
