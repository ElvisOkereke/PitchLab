import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { runs, runStages } from '../../src/db/schema';
import { createRun, executeRun } from '../../src/pipeline/run';
import { defaultRunConfig, STAGES, type Stage, type StageDeps, type StageFn } from '../../src/pipeline/types';
import { testDb } from '../helpers/db';

const deps = (db: Db) => ({ db, router: {}, sources: [], fetchPage: async () => ({}), log: () => {} }) as unknown as StageDeps;

const FULL = { ideaIds: ['i1'], caseIds: ['c1'], signalIds: ['s1'], passed: ['i1'], advisory: [] };

describe('createRun', () => {
  it('inserts a queued run with the config', async () => {
    const db = await testDb();
    const config = defaultRunConfig({ seedType: 'sector', sectors: ['HVAC'] });
    const { id } = await createRun(db, config);
    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row).toMatchObject({ status: 'queued', config, currentStage: null, startedAt: null });
  });
});

describe('executeRun', () => {
  it('runs every stage in order, chaining outputs, and records the run', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const seen: { stage: Stage; input: unknown; runId: string }[] = [];
    const stageImpls = Object.fromEntries(
      STAGES.map((s, n): [Stage, StageFn] => [s, async (_d, run, input) => {
        seen.push({ stage: s, input, runId: run.id });
        return { ...FULL, n };
      }]),
    );
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(seen.map((c) => c.stage)).toEqual([...STAGES]);
    expect(seen[0]!.input).toBeUndefined();
    expect(seen[1]!.input).toEqual({ ...FULL, n: 0 });
    expect(seen[7]!.input).toEqual({ ...FULL, n: 6 });
    expect(seen.every((c) => c.runId === id)).toBe(true);

    const [run] = await db.select().from(runs).where(eq(runs.id, id));
    expect(run).toMatchObject({ status: 'succeeded', currentStage: 'score', error: null });
    expect(run!.startedAt).toBeInstanceOf(Date);
    expect(run!.finishedAt).toBeInstanceOf(Date);
    const stages = await db.select().from(runStages).where(eq(runStages.runId, id));
    expect(stages).toHaveLength(8);
    expect(stages.every((r) => r.status === 'done' && r.finishedAt instanceof Date)).toBe(true);
    expect(stages.find((r) => r.stage === 'gate')!.output).toEqual({ ...FULL, n: 4 });
  });

  it('stores a failed stage error with credentials scrubbed, the message otherwise kept (D2-R1)', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const stageImpls = Object.fromEntries(STAGES.map((s) => [s, async () => {
      if (s === 'ideate') throw new Error('401 from https://user:pw@api.test/v1?key=abc with Bearer sk-ant-api03-SECRETsecret123 at ideate');
      return FULL;
    }]));
    expect(await executeRun(deps(db), id, stageImpls)).toBe('failed');
    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.error).toBe('401 from https://api.test/v1 with Bearer [redacted] at ideate');
  });

  it('resumes from the failed stage without re-running done stages', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const calls: string[] = [];
    let failGate = true;
    const impl = (name: Stage) => async () => {
      calls.push(name);
      if (name === 'gate' && failGate) throw Object.assign(new Error('503'), { status: 503 });
      return FULL;
    };
    const stageImpls = Object.fromEntries(STAGES.map((s) => [s, impl(s)]));
    expect(await executeRun(deps(db), id, stageImpls)).toBe('failed');

    const [failed] = await db.select().from(runs).where(eq(runs.id, id));
    expect(failed).toMatchObject({ status: 'failed', currentStage: 'gate', error: '503' });
    const gateRow = (await db.select().from(runStages).where(eq(runStages.runId, id))).find((r) => r.stage === 'gate');
    expect(gateRow!.status).toBe('failed');

    failGate = false;
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(calls).toEqual(['harvest', 'ideate', 'dedupe', 'screen', 'gate', 'gate', 'case', 'verify', 'score']);
    expect(await db.select().from(runStages).where(eq(runStages.runId, id))).toHaveLength(8);
    const [done] = await db.select().from(runs).where(eq(runs.id, id));
    expect(done).toMatchObject({ status: 'succeeded', error: null });
  });

  it('passes a reused done output to the next stage on resume', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    let fail = true;
    const inputs: unknown[] = [];
    const stageImpls: Partial<Record<Stage, StageFn>> = Object.fromEntries(STAGES.map((s) => [s, async () => FULL]));
    stageImpls.harvest = async () => ({ signalIds: ['from-harvest'] });
    stageImpls.ideate = async (_d, _r, input) => {
      inputs.push(input);
      if (fail) throw new Error('boom');
      return FULL;
    };
    expect(await executeRun(deps(db), id, stageImpls)).toBe('failed');
    fail = false;
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(inputs).toEqual([{ signalIds: ['from-harvest'] }, { signalIds: ['from-harvest'] }]);
  });

  it('short-circuits when screen advances nothing', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const calls: string[] = [];
    const stageImpls = Object.fromEntries(STAGES.map((s) => [s, async () => {
      calls.push(s);
      return s === 'screen' ? { ideaIds: [] } : FULL;
    }]));
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(calls).toEqual(['harvest', 'ideate', 'dedupe', 'screen']);
    const stages = await db.select().from(runStages).where(eq(runStages.runId, id));
    expect(stages).toHaveLength(8);
    expect(stages.every((r) => r.status === 'done')).toBe(true);
    expect(stages.find((r) => r.stage === 'screen')!.output).toEqual({ ideaIds: [] });
    expect(stages.find((r) => r.stage === 'score')!.output).toEqual({});
    const [run] = await db.select().from(runs).where(eq(runs.id, id));
    expect(run).toMatchObject({ status: 'succeeded' });
    expect(run!.finishedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['harvest', { signalIds: [] }, 1],
    ['gate', { passed: [], advisory: [] }, 5],
    ['case', { caseIds: [] }, 6],
    ['verify', { caseIds: [] }, 7],
  ] as const)('short-circuits on an empty %s output', async (stage, empty, expectedCalls) => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
    const calls: string[] = [];
    const stageImpls = Object.fromEntries(STAGES.map((s) => [s, async () => {
      calls.push(s);
      return s === stage ? empty : FULL;
    }]));
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(calls).toHaveLength(expectedCalls);
  });

  it('does not short-circuit an owner idea run when harvest finds no signals', async () => {
    const db = await testDb();
    const { id } = await createRun(db, defaultRunConfig({ seedType: 'idea', ideaText: 'x' }));
    const calls: string[] = [];
    const stageImpls = Object.fromEntries(STAGES.map((s) => [s, async () => {
      calls.push(s);
      return s === 'harvest' ? { signalIds: [] } : FULL;
    }]));
    expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
    expect(calls).toEqual([...STAGES]);
  });

  it('throws for an unknown run id', async () => {
    const db = await testDb();
    await expect(executeRun(deps(db), '00000000-0000-0000-0000-000000000000', {})).rejects.toThrow(/run not found/i);
  });
});
