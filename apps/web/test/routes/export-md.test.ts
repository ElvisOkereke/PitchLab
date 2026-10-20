import { caseToMarkdown } from '@bcg/core/case/export-markdown';
import type { Db } from '@bcg/core/db/client';
import { claims, scores } from '@bcg/core/db/schema';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sectionsFixture } from '../helpers/case-fixture';
import { createTestDb, getCase, seedCase } from '../helpers/db';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db, owner: vi.fn(async () => {}) }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwner: state.owner, requireOwnerAction: async () => {} }));

const { GET } = await import('@/app/(app)/cases/[slug]/export.md/route');

const get = (slug: string) => GET(new Request(`http://localhost:3000/cases/${encodeURIComponent(slug)}/export.md`), { params: Promise.resolve({ slug }) });

let slug: string;

beforeAll(async () => {
  state.db = await createTestDb();
  const c = await seedCase(state.db, { slug: 'lead-flow-verification', title: 'Lead <b>flow</b>', sections: sectionsFixture() });
  slug = c.slug;
  await state.db.insert(claims).values({ caseId: c.id, section: 'evidence', text: 'A claim', sourceUrl: 'https://src.example/1', quote: 'q', verified: 'verified' });
  await state.db.insert(scores).values({ caseId: c.id, criterion: 'pain', value: 4, note: 'n', by: 'ai', model: 'm', promptVersion: 'p' });
});

describe('GET /cases/[slug]/export.md', () => {
  it('returns the shared Markdown export as a no-store, nosniff attachment named after the slug', async () => {
    const res = await get(slug);
    expect(state.owner).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="lead-flow-verification.md"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body.startsWith('# Lead &lt;b&gt;flow&lt;/b&gt;')).toBe(true);

    // Same renderer as the CLI export (no duplicate rendering logic).
    const kase = await getCase(state.db, (await state.db.select().from(claims))[0]!.caseId);
    expect(body).toBe(caseToMarkdown(kase, await state.db.select().from(claims), await state.db.select().from(scores)));
  });

  it('404s an unknown slug', async () => {
    const res = await get('no-such-case');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s a slug outside the slug charset before it can reach a header (CR/LF, quotes, paths)', async () => {
    for (const bad of ['a\r\nSet-Cookie: x=1', 'a"b', "a'b", '../x', 'A-B', 'a b', 'x'.repeat(121), '', 'a;b']) {
      const res = await get(bad);
      expect(res.status, JSON.stringify(bad)).toBe(404);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('checks the session before anything else', async () => {
    state.owner.mockRejectedValueOnce(new Error('NEXT_REDIRECT;/login'));
    await expect(get(slug)).rejects.toThrow('NEXT_REDIRECT;/login');
  });
});
