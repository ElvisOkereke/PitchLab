import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  landingEvents, landingPages, outreachDrafts, outreachEvents, prospects, settings, suppressions, validationPacks,
} from '../../src/db/schema';
import { SENDER_KEYS, getSender, getSetting, setSetting } from '../../src/validation/settings';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { defaultRunConfig } from '../../src/pipeline/types';

type Db = Awaited<ReturnType<typeof testDb>>;

async function aCase(db: Db, slug = 'c1') {
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  return insertCase(db, idea.id, { slug });
}

const prospect = (caseId: string, domain: string) => ({
  caseId, name: 'Acme Freight', website: `https://${domain}/`, domain, location: 'Toronto, ON', fitReason: 'mid-size broker',
  source: 'web_research' as const,
});

describe('validation tables (migration 0004)', () => {
  it('creates every validation table with the expected defaults', async () => {
    const db = await testDb();
    const kase = await aCase(db);

    const [pack] = await db.insert(validationPacks).values({ caseId: kase.id, sections: { a: 1 }, model: 'm', promptVersion: 'p' }).returning();
    expect(pack!.updatedAt).toBeInstanceOf(Date);

    const [p] = await db.insert(prospects).values(prospect(kase.id, 'acme.example')).returning();
    expect(p).toMatchObject({ caslBasis: 'unknown', status: 'new', email: null, emailSourceUrl: null, emailCapturedAt: null, country: null });

    const [d] = await db.insert(outreachDrafts).values({ prospectId: p!.id, kind: 'cold', subject: 's', body: 'b', model: 'm', promptVersion: 'p' }).returning();
    expect(d!.kind).toBe('cold');
    await expect(db.insert(outreachDrafts).values({ prospectId: p!.id, kind: 'cold', subject: 's2', body: 'b2', model: 'm', promptVersion: 'p' })).rejects.toThrow();

    const [e] = await db.insert(outreachEvents).values({ prospectId: p!.id, type: 'sent' }).returning();
    expect(e!.at).toBeInstanceOf(Date);
    expect(e!.note).toBeNull();

    await db.insert(suppressions).values({ email: 'gone@acme.example', reason: 'unsubscribe' });
    await expect(db.insert(suppressions).values({ email: 'gone@acme.example', reason: 'again' })).rejects.toThrow();
    // Stored lowercased only.
    await expect(db.insert(suppressions).values({ email: 'Upper@Acme.example', reason: 'x' })).rejects.toThrow();

    const [lp] = await db.insert(landingPages).values({ caseId: kase.id, slug: 'c1', html: '<p>x</p>', copy: { h: 1 } }).returning();
    expect(lp!.publishedUrl).toBeNull();
    await expect(db.insert(landingPages).values({ caseId: kase.id, slug: 'c1', html: '', copy: {} })).rejects.toThrow();
    const [le] = await db.insert(landingEvents).values({ landingPageId: lp!.id, type: 'visit' }).returning();
    expect(le).toMatchObject({ email: null, company: null, note: null });

    await expect(db.insert(validationPacks).values({ caseId: kase.id, sections: {}, model: 'm', promptVersion: 'p' })).rejects.toThrow();
    await db.insert(settings).values({ key: 'k', value: 'v' });
  });

  it('allows one prospect per (case, domain), and the same domain in another case', async () => {
    const db = await testDb();
    const k1 = await aCase(db, 'c1');
    const k2 = await aCase(db, 'c2');
    await db.insert(prospects).values(prospect(k1.id, 'acme.example'));
    await expect(db.insert(prospects).values(prospect(k1.id, 'acme.example'))).rejects.toThrow();
    await db.insert(prospects).values(prospect(k2.id, 'acme.example'));
    const rows = await db.execute(sql`select count(*)::int as n from prospects`);
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(2);
  });

  it('indexes the event foreign keys (migration 0005)', async () => {
    const db = await testDb();
    const res = await db.execute(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'`);
    const rows = (res as unknown as { rows: { tablename: string; indexname: string; indexdef: string }[] }).rows;
    const has = (table: string, column: string) => rows.some((r) => r.tablename === table && r.indexdef.includes(`(${column})`));
    expect(has('outreach_events', 'prospect_id')).toBe(true);
    expect(has('landing_events', 'landing_page_id')).toBe(true);
  });

  it('rejects unknown enum values', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    await expect(db.insert(prospects).values({ ...prospect(kase.id, 'a.example'), caslBasis: 'bought' as never })).rejects.toThrow();
    await expect(db.insert(prospects).values({ ...prospect(kase.id, 'b.example'), status: 'spam' as never })).rejects.toThrow();
  });
});

describe('settings', () => {
  it('round-trips JSON values and overwrites on set', async () => {
    const db = await testDb();
    expect(await getSetting(db, 'sender.name')).toBeNull();
    await setSetting(db, 'sender.name', 'Pat Owner');
    expect(await getSetting(db, 'sender.name')).toBe('Pat Owner');
    await setSetting(db, 'sender.name', 'Pat B. Owner');
    expect(await getSetting(db, 'sender.name')).toBe('Pat B. Owner');
    await setSetting(db, 'landing.form', { endpoint: 'https://x.example/f', n: 2 });
    expect(await getSetting(db, 'landing.form')).toEqual({ endpoint: 'https://x.example/f', n: 2 });
  });

  it('lists the sender keys', () => {
    expect(SENDER_KEYS).toEqual(['sender.name', 'sender.company', 'sender.address', 'sender.contact', 'sender.email']);
  });

  it('getSender reports every missing required key when nothing is set', async () => {
    const db = await testDb();
    expect(await getSender(db)).toEqual({ sender: null, missing: ['sender.name', 'sender.address', 'sender.contact'] });
  });

  it('getSender treats blank and non-string values as missing', async () => {
    const db = await testDb();
    await setSetting(db, 'sender.name', 'Pat');
    await setSetting(db, 'sender.address', '   ');
    await setSetting(db, 'sender.contact', 42);
    expect(await getSender(db)).toEqual({ sender: null, missing: ['sender.address', 'sender.contact'] });
  });

  it('getSender returns a complete identity; company and email are optional', async () => {
    const db = await testDb();
    await setSetting(db, 'sender.name', ' Pat Owner ');
    await setSetting(db, 'sender.address', '1 Main St, Toronto ON M5V 1A1');
    await setSetting(db, 'sender.contact', 'https://pat.example');
    expect(await getSender(db)).toEqual({
      sender: { name: 'Pat Owner', address: '1 Main St, Toronto ON M5V 1A1', contact: 'https://pat.example' },
      missing: [],
    });
    await setSetting(db, 'sender.company', 'Pat Co');
    await setSetting(db, 'sender.email', 'pat@pat.example');
    expect((await getSender(db)).sender).toEqual({
      name: 'Pat Owner', company: 'Pat Co', address: '1 Main St, Toronto ON M5V 1A1', contact: 'https://pat.example', email: 'pat@pat.example',
    });
  });
});
