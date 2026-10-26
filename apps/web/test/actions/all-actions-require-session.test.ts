// Review Focus 1: every exported Server Action (except login/logout in auth.ts) must refuse a request without a session
// or from a foreign Origin, and leave the DB untouched. Modules added to apps/web/actions/ are picked up automatically,
// and the test FAILS until the new action has an entry in SPECS: a seed that creates what that action needs and returns
// form fields that make it write. Each action is then shown, on its own fresh DB, to write when authorised and not to
// write when unauthorised (D2-R5 item 7).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '@bcg/core/db/client';
import { benchmarkPasses } from '@bcg/core/db/schema';
import { ensureExample, hideExample } from '@bcg/core/example/example';
import { setSetting } from '@bcg/core/validation/settings';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedCase, seedFailedRun, seedGatedOutIdea, seedProspect, snapshotDb } from '../helpers/db';
import { TEST_SECRET, resetRequest, useTestEnv } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));

type Action = (...args: unknown[]) => Promise<unknown>;
/** `args` replaces the FormData built from the seeded fields, for actions called from client code with a plain object. */
type Spec = { seed: (db: Db) => Promise<Record<string, string>>; args?: () => unknown[] };

/** Per action: seed what it needs and return form fields (or `args`) that make it write when authorised. */
const SPECS: Record<string, Spec> = {
  'stage.ts#moveStageAction': {
    seed: async (db) => {
      const c = await seedCase(db);
      return { caseId: c.id, slug: c.slug, from: 'new', to: 'validating' };
    },
  },
  'stage.ts#overturnKillAction': {
    seed: async (db) => {
      const c = await seedCase(db, { stage: 'killed', killReason: 'meh' });
      return { caseId: c.id, slug: c.slug };
    },
  },
  'stage.ts#rerunGateKillAction': {
    seed: async (db) => ({ ideaId: (await seedGatedOutIdea(db)).id }),
  },
  'scores.ts#saveOwnerScoresAction': {
    seed: async (db) => {
      const c = await seedCase(db);
      return { caseId: c.id, slug: c.slug, value_gut: '4', note_gut: 'promising' };
    },
  },
  'outreach.ts#markOutreachAction': {
    seed: async (db) => {
      const { kase, prospect } = await seedProspect(db);
      // The interview-note path (type `note`), added in D2-R6; `sent` and the others are covered in outreach.test.ts.
      return { prospectId: prospect.id, slug: kase.slug, type: 'note', note: 'interview: owner says forms break monthly' };
    },
  },
  'runs.ts#queueRunAction': {
    seed: async () => ({ seedType: 'open', ideaCount: '1', advanceCount: '1' }),
  },
  'example.ts#hideExampleAction': {
    seed: async (db) => {
      await ensureExample(db);
      return {};
    },
  },
  'example.ts#resetExampleAction': {
    seed: async (db) => {
      await ensureExample(db);
      await hideExample(db);
      return {};
    },
  },
  'runs.ts#requeueRunAction': {
    seed: async (db) => ({ runId: (await seedFailedRun(db)).id }),
  },
  'bench.ts#runBenchmarkAction': {
    seed: async () => ({}),
  },
  'bench.ts#recomputePassAction': {
    seed: async (db) => {
      const [p] = await db.insert(benchmarkPasses).values({
        version: 'bench-v1', label: 'bench-v1 #1', kind: 'pass', status: 'complete', runIds: [], completedAt: new Date(),
      }).returning({ id: benchmarkPasses.id });
      return { passId: p!.id };
    },
  },
  'validation.ts#queueValidationAction': {
    seed: async (db) => {
      const c = await seedCase(db);
      await setSetting(db, 'sender.name', 'Al Owner');
      await setSetting(db, 'sender.address', '1 Main St');
      await setSetting(db, 'sender.contact', 'al@owner.example');
      return { caseId: c.id, slug: c.slug, prospects: '5' };
    },
  },
  'settings.ts#saveSettingsAction': {
    seed: async () => ({ 'sender.name': 'Al Owner', 'landing.formEndpoint': 'https://forms.example/f' }),
  },
  'tour.ts#saveTourStateAction': {
    seed: async () => ({}),
    args: () => [{ version: 1, completed: ['setup'], current: { chapter: 'generate', step: 0 }, dismissed: false }],
  },
};

const actionsDir = fileURLToPath(new URL('../../actions/', import.meta.url));

async function allActionExports(): Promise<[string, Action][]> {
  const files = readdirSync(actionsDir).filter((f) => /\.tsx?$/.test(f) && f !== 'auth.ts');
  const out: [string, Action][] = [];
  for (const f of files) {
    const mod = (await import(/* @vite-ignore */ `../../actions/${f}`)) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(mod)) if (typeof fn === 'function') out.push([`${f}#${name}`, fn as Action]);
  }
  return out;
}

function argsFor(fn: Action, fields: Record<string, string>, spec?: Spec): unknown[] {
  if (spec?.args) return spec.args();
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  // (prev, fd) actions for useActionState, (fd) actions for plain forms, () for buttons without fields.
  return fn.length >= 2 ? [{}, fd] : fn.length === 1 ? [fd] : [];
}

const LOGIN_REDIRECT = /NEXT_REDIRECT;\/login$/;
let actions: [string, Action][] = [];
let goodCookie: Record<string, string>;
let forgedCookies: Record<string, string>[];

beforeAll(async () => {
  useTestEnv();
  actions = await allActionExports();
  const { signSession } = await import('@/lib/auth/session');
  goodCookie = { bcg_session: await signSession(TEST_SECRET) };
  forgedCookies = [
    { bcg_session: await signSession('another-secret-another-secret-123456') },
    { bcg_session: await signSession(TEST_SECRET, new Date(Date.now() - 8 * 86_400_000)) },
    {},
  ];
});

describe('every Server Action requires a session and a same-origin request', () => {
  it('finds the action modules and has a spec for every exported action', () => {
    const names = actions.map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining([
      'stage.ts#moveStageAction', 'stage.ts#overturnKillAction', 'stage.ts#rerunGateKillAction',
      'scores.ts#saveOwnerScoresAction', 'outreach.ts#markOutreachAction',
      'runs.ts#queueRunAction', 'runs.ts#requeueRunAction', 'settings.ts#saveSettingsAction', 'tour.ts#saveTourStateAction',
    ]));
    expect(names.filter((n) => !SPECS[n])).toEqual([]);
  });

  it('each action, on its own seeded DB: refused without a valid session or from a foreign Origin (no writes), writes when authorised', async () => {
    for (const [name, fn] of actions) {
      state.db = await createTestDb();
      const fields = await SPECS[name]!.seed(state.db);
      const before = await snapshotDb(state.db);

      for (const cookies of forgedCookies) {
        resetRequest({ cookies });
        await expect(fn(...argsFor(fn, fields, SPECS[name])), `${name} without a valid session`).rejects.toThrow(LOGIN_REDIRECT);
      }
      for (const origin of ['https://evil.com', null, 'null']) {
        resetRequest({ origin, cookies: goodCookie });
        await expect(fn(...argsFor(fn, fields, SPECS[name])), `${name} origin=${origin}`).rejects.toThrow('Forbidden');
      }
      expect(await snapshotDb(state.db), `${name} wrote while unauthorised`).toEqual(before);

      // Control: the same call, authorised, does write (so the refusals above are meaningful for this action).
      resetRequest({ cookies: goodCookie });
      await fn(...argsFor(fn, fields, SPECS[name])).catch((e: unknown) => {
        if (!(e instanceof Error && e.message.startsWith('NEXT_REDIRECT'))) throw e;
      });
      expect(await snapshotDb(state.db), `${name} did not write when authorised`).not.toEqual(before);
    }
  });
});
