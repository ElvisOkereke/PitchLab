// Review Focus 1: every exported Server Action (except login/logout in auth.ts) must refuse a request without a session
// or from a foreign Origin, and leave the DB untouched. Modules added to apps/web/actions/ are picked up automatically;
// extend FIELDS when a new action needs other form fields to reach its write path.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '@bcg/core/db/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedCase, seedGatedOutIdea, snapshotDb } from '../helpers/db';
import { TEST_SECRET, resetRequest, useTestEnv } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));

const actionsDir = fileURLToPath(new URL('../../actions/', import.meta.url));
type Action = (...args: unknown[]) => Promise<unknown>;

async function allActionExports(): Promise<[string, Action][]> {
  const files = readdirSync(actionsDir).filter((f) => /\.tsx?$/.test(f) && f !== 'auth.ts');
  const out: [string, Action][] = [];
  for (const f of files) {
    const mod = (await import(/* @vite-ignore */ `../../actions/${f}`)) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(mod)) if (typeof fn === 'function') out.push([`${f}#${name}`, fn as Action]);
  }
  return out;
}

/** Form fields that would make each action write if it skipped the auth check. */
let FIELDS: Record<string, string> = {};

function argsFor(fn: Action): unknown[] {
  const fd = new FormData();
  for (const [k, v] of Object.entries(FIELDS)) fd.set(k, v);
  // (prev, fd) actions for useActionState, (fd) actions for plain forms, () for buttons without fields.
  return fn.length >= 2 ? [{}, fd] : fn.length === 1 ? [fd] : [];
}

let actions: [string, Action][] = [];

beforeAll(async () => {
  useTestEnv();
  actions = await allActionExports();
});

beforeEach(async () => {
  state.db = await createTestDb();
  const c = await seedCase(state.db);
  const idea = await seedGatedOutIdea(state.db);
  FIELDS = { caseId: c.id, slug: c.slug, from: 'new', to: 'validating', note: 'n', ideaId: idea.id };
});

async function sessionCookie() {
  const { signSession } = await import('@/lib/auth/session');
  return { bcg_session: await signSession(TEST_SECRET) };
}

describe('every Server Action requires a session and a same-origin request', () => {
  it('finds the action modules', () => {
    expect(actions.map(([n]) => n)).toEqual(expect.arrayContaining(['stage.ts#moveStageAction', 'stage.ts#overturnKillAction', 'stage.ts#rerunGateKillAction']));
  });

  it('every exported action redirects to /login without a session and writes nothing', async () => {
    const before = await snapshotDb(state.db);
    for (const [name, fn] of actions) {
      resetRequest();
      await expect(fn(...argsFor(fn)), name).rejects.toThrow(/NEXT_REDIRECT;\/login$/);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('every exported action throws Forbidden on a foreign or missing Origin even with a valid session', async () => {
    const cookies = await sessionCookie();
    const before = await snapshotDb(state.db);
    for (const [name, fn] of actions) {
      for (const origin of ['https://evil.com', null, 'null']) {
        resetRequest({ origin, cookies });
        await expect(fn(...argsFor(fn)), `${name} origin=${origin}`).rejects.toThrow('Forbidden');
      }
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('a forged or expired cookie counts as no session', async () => {
    const { signSession } = await import('@/lib/auth/session');
    const before = await snapshotDb(state.db);
    for (const bcg_session of [await signSession('another-secret-another-secret-123456'), await signSession(TEST_SECRET, new Date(Date.now() - 8 * 86_400_000))]) {
      for (const [name, fn] of actions) {
        resetRequest({ cookies: { bcg_session } });
        await expect(fn(...argsFor(fn)), name).rejects.toThrow(/NEXT_REDIRECT;\/login$/);
      }
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('control: with a session and same origin the same calls do write (so the checks above are meaningful)', async () => {
    const cookies = await sessionCookie();
    const before = await snapshotDb(state.db);
    for (const [, fn] of actions) {
      resetRequest({ cookies });
      await fn(...argsFor(fn)).catch(() => undefined);
    }
    expect(await snapshotDb(state.db)).not.toEqual(before);
  });
});
