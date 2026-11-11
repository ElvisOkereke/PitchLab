import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { runStages } from '../../src/db/schema';
import { passthrough } from '../../src/pipeline/engine/passthrough';
import { createRun, executeRun } from '../../src/pipeline/run';
import { defaultRunConfig, STAGES, usesEngineV2, type Stage, type StageDeps, type StageFn } from '../../src/pipeline/types';
import { RunConfigSchema } from '../../src/dashboard/runs';
import { testDb } from '../helpers/db';

const deps = (db: Db) => ({ db, router: {}, sources: [], fetchPage: async () => ({}), log: () => {} }) as unknown as StageDeps;

describe('engine v2 scaffolding', () => {
  it('lists the v2 stages between harvest and ideate', () => {
    expect([...STAGES]).toEqual(['harvest', 'sketch', 'archive', 'tournament', 'evolve', 'ideate', 'dedupe', 'screen', 'gate', 'case', 'verify', 'score']);
  });

  it('usesEngineV2 is true by default, false for engine v1 and for an owner idea', () => {
    expect(defaultRunConfig({ seedType: 'open' }).engine).toBe('v2');
    expect(usesEngineV2(defaultRunConfig({ seedType: 'open' }))).toBe(true);
    expect(usesEngineV2(defaultRunConfig({ seedType: 'sector', engine: 'v2' }))).toBe(true);
    expect(usesEngineV2(defaultRunConfig({ seedType: 'open', engine: 'v1' }))).toBe(false);
    expect(usesEngineV2(defaultRunConfig({ seedType: 'idea', ideaText: 'x' }))).toBe(false);
  });

  it('a stored config without an engine (a run from before engine v2) stays v1', () => {
    const { engine: _e, ...stored } = defaultRunConfig({ seedType: 'open' });
    expect(usesEngineV2(stored)).toBe(false);
    expect(usesEngineV2(RunConfigSchema.parse(stored))).toBe(false);
    expect(RunConfigSchema.parse(defaultRunConfig({ seedType: 'open' })).engine).toBe('v2');
    expect(RunConfigSchema.parse({ ...stored, engine: 'v1' }).engine).toBe('v1');
    expect(RunConfigSchema.safeParse({ ...stored, engine: 'v3' }).success).toBe(false);
  });

  it('passthrough returns its input unchanged', async () => {
    const input = { signalIds: ['s1'], extra: { a: 1 } };
    expect(await passthrough({} as never, {} as never, input)).toEqual(input);
  });

  it('the default new stages pass the harvest output through to ideate', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open', engine: 'v1' }));
    const harvestOut = { signalIds: ['s1'], libraryItemIds: [] };
    let ideateInput: unknown;
    const impls: Partial<Record<Stage, StageFn>> = {
      harvest: async () => harvestOut,
      ideate: async (_d, _r, input) => { ideateInput = input; return { ideaIds: [] }; },
    };
    expect(await executeRun(deps(db), id, impls)).toBe('succeeded');
    expect(ideateInput).toEqual(harvestOut);
    const rows = await db.select().from(runStages).where(eq(runStages.runId, id));
    for (const s of ['sketch', 'archive', 'tournament', 'evolve']) expect(rows.find((r) => r.stage === s)!.output).toEqual(harvestOut);
  });

  it('a run with no sketches left ends like an empty ideate', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const impls: Partial<Record<Stage, StageFn>> = {
      harvest: async () => ({ signalIds: ['s1'] }),
      sketch: async () => ({ sketchIds: [] }),
    };
    expect(await executeRun(deps(db), id, impls)).toBe('succeeded');
    const rows = await db.select().from(runStages).where(eq(runStages.runId, id));
    expect(rows.find((r) => r.stage === 'ideate')!.output).toEqual({});
  });
});
