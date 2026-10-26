import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOUR_CHAPTERS } from '@bcg/core/dashboard/tour-ids';
import { describe, expect, it } from 'vitest';
import { CHAPTERS } from '@/lib/tour/chapters';
import { routeOf } from '@/lib/tour/machine';

const all = TOUR_CHAPTERS.flatMap((id) => CHAPTERS[id].steps.map((s) => ({ chapter: id, ...s })));
const find = (id: string) => all.find((s) => s.id === id)!;

describe('tour chapters', () => {
  it('has all 8 chapters in TOUR_CHAPTERS order, each with at least 2 steps', () => {
    expect(Object.keys(CHAPTERS)).toEqual([...TOUR_CHAPTERS]);
    for (const id of TOUR_CHAPTERS) {
      expect(CHAPTERS[id].title.length, id).toBeGreaterThan(0);
      expect(CHAPTERS[id].steps.length, id).toBeGreaterThanOrEqual(2);
    }
  });

  it('every step id is unique', () => {
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('titles and bodies are plain text: non-empty, no < > & (driver.js uses innerHTML), no ${', () => {
    for (const s of all) {
      for (const text of [s.title, s.body]) {
        expect(typeof text, s.id).toBe('string');
        expect(text.trim().length, s.id).toBeGreaterThan(0);
        expect(text, s.id).not.toMatch(/[<>&]|\$\{/);
      }
      expect(CHAPTERS[s.chapter].title).not.toMatch(/[<>&]/);
    }
  });

  it('bodies are short (at most 320 characters)', () => {
    for (const s of all) expect([s.id, s.body.length <= 320]).toEqual([s.id, true]);
  });

  it('no internal jargon in step text', () => {
    for (const s of all) expect(`${s.title} ${s.body}`, s.id).not.toMatch(/R13|gate\.v|SDD|TODO/);
  });

  it('chapter 1 checks the worker badge before the Settings connections', () => {
    const setup = CHAPTERS.setup.steps;
    const worker = setup.findIndex((s) => s.target === 'worker-badge');
    const connections = setup.findIndex((s) => s.target === 'settings-connections');
    expect(worker).toBeGreaterThanOrEqual(0);
    expect(connections).toBeGreaterThan(worker);
    expect(setup[worker]!.route).toBe('/command');
    expect(setup[connections]!.route).toBe('/settings');
  });

  it('chapter 2: Queue run is an action that waits for "Queued", shows the cost and says which seeds may give no case', () => {
    const submit = CHAPTERS.generate.steps.find((s) => s.target === 'queue-submit')!;
    expect(submit.kind).toBe('action');
    expect(submit.advanceOn).toEqual({ appears: 'queue-ok' });
    expect(submit.body).toContain('$');
    expect(submit.body).toMatch(/Open, Sectors (and|or) Lenses/);
    expect(submit.body).toContain('Your idea');
    const last = CHAPTERS.generate.steps.at(-1)!;
    expect(last.body).toBe('Runs take a while. The rest of the tour uses your newest case, or the built-in example until you have one.');
  });

  it('chapter 6: Generate validation pack is an action that waits for the job status and shows the cost', () => {
    const gen = CHAPTERS.validate.steps.find((s) => s.target === 'validate-generate')!;
    expect(gen.kind).toBe('action');
    expect(gen.advanceOn).toEqual({ appears: 'validate-status' });
    expect(gen.body).toContain('$');
    expect(gen.body).toContain('Generate validation pack');
  });

  it('chapter 7 says the app never sends email', () => {
    expect(CHAPTERS.outreach.steps.some((s) => /never sends email/.test(s.body))).toBe(true);
  });

  it('chapter 8 shows the example settings and ends by naming Take the tour and the docs', () => {
    expect(CHAPTERS.decide.steps.some((s) => s.target === 'settings-example' && s.route === '/settings')).toBe(true);
    const last = CHAPTERS.decide.steps.at(-1)!;
    expect(last.body).toContain('Take the tour');
    expect(last.body).toMatch(/docs/);
  });

  it('steps waiting on a run or a validation job offer "come back later"', () => {
    expect(CHAPTERS.generate.steps.at(-1)!.wait).toBe(true);
    expect(find('validate-wait').wait).toBe(true);
  });

  it('case-page routes use the tour case, with the right tab, and resolve to null without a case', () => {
    const casey = all.filter((s) => typeof s.route === 'function');
    expect(casey.length).toBeGreaterThan(10);
    for (const s of casey) {
      expect(routeOf(s, { caseSlug: null }), s.id).toBeNull();
      expect(routeOf(s, { caseSlug: 'demo' }), s.id).toMatch(/^\/cases\/demo(\?tab=(evidence|numbers|competitors|pitch|validate|score))?$/);
    }
    expect(routeOf(find('score-form'), { caseSlug: 'demo' })).toBe('/cases/demo?tab=score');
    expect(routeOf(find('validate-generate'), { caseSlug: 'demo' })).toBe('/cases/demo?tab=validate');
  });

  it('every non-case route is a real page', () => {
    for (const s of all) if (typeof s.route === 'string') expect(['/', '/command', '/runs', '/library', '/settings', '/leaderboard', '/progress'], s.id).toContain(s.route);
  });

  it('action steps say how they advance', () => {
    for (const s of all.filter((x) => x.kind === 'action')) expect(s.advanceOn, s.id).toBeDefined();
  });

  it('chapters.ts imports nothing but types and core TOUR_CHAPTERS, so step text cannot come from data', () => {
    const src = readFileSync(fileURLToPath(new URL('../../lib/tour/chapters.ts', import.meta.url)), 'utf8');
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      const typeOnly = /^\s*import type\b/.test(line);
      const tourIds = /^\s*import \{ TOUR_CHAPTERS \} from '@bcg\/core\/dashboard\/tour-ids';\s*$/.test(line);
      expect([line, typeOnly || tourIds]).toEqual([line, true]);
    }
  });
});
