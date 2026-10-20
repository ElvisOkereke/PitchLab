import type { Db } from '@bcg/core/db/client';
import { outreachEvents, prospects, suppressions } from '@bcg/core/db/schema';
import { markOutreach } from '@bcg/core/validation/tracking';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedProspect, snapshotDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { markOutreachAction } = await import('@/actions/outreach');

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** The rows a mark leaves behind, without ids and timestamps, for comparing two databases. */
async function trackingState(db: Db, prospectId: string) {
  const [p] = await db.select({ status: prospects.status }).from(prospects).where(eq(prospects.id, prospectId));
  const events = (await db.select().from(outreachEvents).where(eq(outreachEvents.prospectId, prospectId)).orderBy(outreachEvents.at))
    .map((e) => [e.type, e.note]);
  const sup = (await db.select().from(suppressions)).map((s) => [s.email, s.reason]);
  return { status: p!.status, events, sup };
}

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('markOutreachAction', () => {
  it('markOutreachAction writes the same rows as gen outreach mark (event + status + suppression on unsubscribe)', async () => {
    const cli = await createTestDb();
    const web = await seedProspect(state.db, { email: 'Hello@Agency.example' });
    const viaCli = await seedProspect(cli, { email: 'Hello@Agency.example' });

    for (const [type, note] of [['sent', ''], ['replied', 'asked for price'], ['unsubscribe', '']] as const) {
      const r = await markOutreachAction({}, form({ prospectId: web.prospect.id, slug: web.kase.slug, type, note }));
      expect(r).toEqual({ ok: true });
      await markOutreach(cli, viaCli.prospect.id, type, note === '' ? undefined : note);
    }
    const a = await trackingState(state.db, web.prospect.id);
    expect(a).toEqual(await trackingState(cli, viaCli.prospect.id));
    expect(a).toEqual({
      status: 'unsubscribed',
      events: [['sent', null], ['replied', 'asked for price'], ['unsubscribe', null]],
      sup: [['hello@agency.example', 'unsubscribe']],
    });
    expect(request.revalidated).toEqual(expect.arrayContaining([`/cases/${web.kase.slug}`, '/command']));
  });

  it('status never regresses (same rule as the CLI)', async () => {
    const { prospect } = await seedProspect(state.db, { status: 'meeting' });
    await markOutreachAction({}, form({ prospectId: prospect.id, type: 'sent' }));
    const [p] = await state.db.select().from(prospects).where(eq(prospects.id, prospect.id));
    expect(p!.status).toBe('meeting');
  });

  it('rejects a bad id, an unknown type (including note) and a long note, writing nothing', async () => {
    const { prospect } = await seedProspect(state.db);
    const before = await snapshotDb(state.db);
    for (const fields of <Record<string, string>[]>[
      { prospectId: 'nope', type: 'sent' },
      { prospectId: prospect.id, type: 'bounced' },
      { prospectId: prospect.id, type: 'note' },
      { prospectId: prospect.id },
      { prospectId: prospect.id, type: 'sent', note: 'x'.repeat(501) },
    ]) {
      const r = await markOutreachAction({}, form(fields));
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(/\w/);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('reports a prospect that no longer exists', async () => {
    expect(await markOutreachAction({}, form({ prospectId: '00000000-0000-4000-8000-000000000000', type: 'sent' })))
      .toEqual({ error: 'This prospect no longer exists. Refresh.' });
  });
});
