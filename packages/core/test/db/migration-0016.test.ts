import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ideas, judgePairs, runs, sketches, tournamentMatches } from '../../src/db/schema';
import { BUYER_KINDS, EDGE_KINDS } from '../../src/pipeline/engine/kinds';
import { testDb } from '../helpers/db';

type Col = { column_name: string; is_nullable: string; data_type: string };

describe('migration 0016 (engine v2)', () => {
  it('adds the three tables and three columns, additively', async () => {
    const db = await testDb();
    const cols = async (t: string) => ((await db.execute(sql`select column_name, is_nullable, data_type from information_schema.columns where table_name = ${t}`)) as unknown as { rows: Col[] }).rows;
    expect((await cols('ideas')).find((c) => c.column_name === 'sketch_id')).toMatchObject({ is_nullable: 'YES', data_type: 'uuid' });
    expect((await cols('ideas')).find((c) => c.column_name === 'elo')).toMatchObject({ is_nullable: 'YES', data_type: 'real' });
    expect((await cols('knowledge_items')).find((c) => c.column_name === 'assessment')).toMatchObject({ is_nullable: 'YES', data_type: 'jsonb' });
    for (const t of ['sketches', 'tournament_matches', 'judge_pairs']) expect((await cols(t)).length, t).toBeGreaterThan(5);

    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const sk = { runId: run!.id, title: 't', buyer: 'b', problem: 'p', howItEarns: 'h', businessModel: 'subscription', edge: 'e', edgeKind: 'data' as const, whyNotTrivial: 'w', earnOrSave: 'earn', signalIds: [], libraryItemIds: [], status: 'kept' as const };
    const [a] = await db.insert(sketches).values(sk).returning();
    expect(a).toMatchObject({ elo: null, parentSketchId: null, operator: null, embedding: null, cell: null });
    const [b] = await db.insert(sketches).values({ ...sk, title: 't2', status: 'duplicate' }).returning();
    const [idea] = await db.insert(ideas).values({ runId: run!.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' }).returning();
    expect(idea).toMatchObject({ sketchId: null, elo: null });

    const m = { runId: run!.id, phase: 'main' as const, round: 1, aId: a!.id, bId: b!.id, verdictAB: 'a' as const, verdictBA: 'a' as const, result: 'draw' as const, confidence: 0.5, reasons: {} };
    await db.insert(tournamentMatches).values(m);
    await expect(db.insert(tournamentMatches).values(m)).rejects.toThrow();

    const pair = { keptIdeaId: idea!.id, killedIdeaId: idea!.id, pairHash: 'h1', split: 'train' as const };
    await db.insert(judgePairs).values(pair);
    expect((await db.select().from(judgePairs))[0]!.reason).toBeNull();
    await expect(db.insert(judgePairs).values(pair)).rejects.toThrow();

    const dir = join(__dirname, '..', '..', 'drizzle');
    const migration = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith('0016_'))!), 'utf8');
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
  });

  it('exports the edge and buyer kinds', () => {
    expect([...EDGE_KINDS]).toEqual(['data', 'workflow', 'regulation', 'network', 'ai_capability', 'distribution', 'none']);
    expect([...BUYER_KINDS]).toEqual(['business', 'prosumer', 'consumer']);
  });
});
