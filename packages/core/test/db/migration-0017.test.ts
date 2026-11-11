import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { gateCheck, gateVerdicts } from '../../src/db/schema';
import { ADVISORY_GATE_CHECKS, isAdvisoryGateCheck } from '../../src/pipeline/gate-checks';
import { insertIdea, insertRun, testDb } from '../helpers/db';
import { defaultRunConfig } from '../../src/pipeline/types';

describe('migration 0017 (gate v7 checks)', () => {
  it('adds trivial and comps to the gate check enum, additively', async () => {
    const db = await testDb();
    const labels = ((await db.execute(sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'gate_check' order by e.enumsortorder`)) as unknown as { rows: { enumlabel: string }[] }).rows.map((r) => r.enumlabel);
    expect(labels).toEqual(['generic', 'regulation', 'control', 'autonomy', 'reachability', 'evidence', 'scale', 'trivial', 'comps']);
    expect([...gateCheck.enumValues]).toEqual(labels);
    // The advisory (flag-only) verdicts are gate checks; only comps is advisory.
    expect([...ADVISORY_GATE_CHECKS]).toEqual(['comps']);
    for (const c of ADVISORY_GATE_CHECKS) expect(labels).toContain(c);
    expect(labels.filter(isAdvisoryGateCheck)).toEqual(['comps']);

    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id);
    await db.insert(gateVerdicts).values(['trivial', 'comps'].map((check) => ({
      ideaId: idea.id, check: check as 'trivial' | 'comps', pass: true, reasoning: 'r', model: 'm', promptVersion: 'p',
    })));
    expect(await db.select().from(gateVerdicts)).toHaveLength(2);

    const dir = join(__dirname, '..', '..', 'drizzle');
    const migration = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith('0017_'))!), 'utf8');
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    expect(migration).toMatch(/ADD VALUE 'trivial'/);
    expect(migration).toMatch(/ADD VALUE 'comps'/);
  });
});
