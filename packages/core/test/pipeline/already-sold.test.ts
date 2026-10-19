import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { gateVerdicts } from '../../src/db/schema';
import { loadAlreadySold } from '../../src/pipeline/already-sold';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

const verdict = (db: Db, ideaId: string, check: 'generic' | 'autonomy' | 'evidence', pass: boolean, reasoning: string) =>
  db.insert(gateVerdicts).values({ ideaId, check, pass, reasoning, sources: [], model: 'm', promptVersion: 'gate.v1' });

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

describe('loadAlreadySold', () => {
  it('lists gated_out ideas with a failed generic verdict as "title — reasoning", one entry per idea', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const sold = await insertIdea(db, run.id, { title: 'Invoice audits', status: 'gated_out' });
    await verdict(db, sold.id, 'generic', false, 'Acme and Beta already sell invoice audits to property managers');
    await verdict(db, sold.id, 'autonomy', false, 'needs a human');
    await verdict(db, sold.id, 'evidence', true, 'fine');
    const out = await loadAlreadySold(db);
    expect(out.sold).toEqual(['Invoice audits — Acme and Beta already sell invoice audits to property managers']);
  });

  it('does not list an idea whose only failed check is autonomy, nor a passed generic check', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const autonomyOnly = await insertIdea(db, run.id, { title: 'Autonomy only', status: 'gated_out' });
    await verdict(db, autonomyOnly.id, 'generic', true, 'distinct');
    await verdict(db, autonomyOnly.id, 'autonomy', false, 'needs a human');
    const notKilled = await insertIdea(db, run.id, { title: 'Advanced', status: 'advanced' });
    await verdict(db, notKilled.id, 'generic', false, 'advisory only');
    expect((await loadAlreadySold(db)).sold).toEqual([]);
  });

  it('caps title and reasoning at 200 chars each and collapses newlines', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { title: `${'T'.repeat(250)}`, status: 'gated_out' });
    await verdict(db, idea.id, 'generic', false, `line\none ${'r'.repeat(300)}`);
    const [entry] = (await loadAlreadySold(db)).sold;
    const [title, reasoning] = entry!.split(' — ');
    expect(title).toBe('T'.repeat(200));
    expect(reasoning).toHaveLength(200);
    expect(reasoning!.startsWith('line one r')).toBe(true);
  });

  it('lists titles of ideas with a case (owner ideas included) as covered', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea' }));
    const owner = await insertIdea(db, run.id, { title: 'Owner case', origin: 'owner', status: 'advanced' });
    await insertCase(db, owner.id);
    const generated = await insertIdea(db, run.id, { title: 'Generated case', status: 'advanced' });
    await insertCase(db, generated.id);
    await insertIdea(db, run.id, { title: 'No case', status: 'advanced' });
    const out = await loadAlreadySold(db);
    expect(out.covered).toHaveLength(2);
    expect(out.covered).toEqual(expect.arrayContaining(['Owner case', 'Generated case']));
  });

  it('caps each list at 15 by default (or the given limit), newest first', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    for (let i = 0; i < 20; i++) {
      const killed = await insertIdea(db, run.id, { title: `Killed ${i}`, status: 'gated_out', createdAt: at(i) });
      await verdict(db, killed.id, 'generic', false, `r${i}`);
      const written = await insertIdea(db, run.id, { title: `Written ${i}`, status: 'advanced', createdAt: at(i) });
      await insertCase(db, written.id, { createdAt: at(i) });
    }
    const out = await loadAlreadySold(db);
    expect(out.sold).toHaveLength(15);
    expect(out.sold[0]).toBe('Killed 19 — r19');
    expect(out.sold[14]).toBe('Killed 5 — r5');
    expect(out.covered).toHaveLength(15);
    expect(out.covered[0]).toBe('Written 19');
    expect(out.covered[14]).toBe('Written 5');
    const small = await loadAlreadySold(db, 3);
    expect(small.sold).toEqual(['Killed 19 — r19', 'Killed 18 — r18', 'Killed 17 — r17']);
    expect(small.covered).toEqual(['Written 19', 'Written 18', 'Written 17']);
  });

  it('returns empty lists on empty tables', async () => {
    expect(await loadAlreadySold(await testDb())).toEqual({ sold: [], covered: [] });
  });
});
