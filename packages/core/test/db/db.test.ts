import { describe, it, expect } from 'vitest';
import { sql, cosineDistance } from 'drizzle-orm';
import { testDb } from '../helpers/db';
import { seedDefaults, CONSUMER_SEGMENTS } from '../../src/db/seed';
import { eq } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cases, claims, finds, ideaReviews, lenses, markets, runs, ideas, signals } from '../../src/db/schema';

describe('db', () => {
  it('migrates, seeds idempotently, and supports vector similarity', async () => {
    const db = await testDb();
    await seedDefaults(db);
    expect(await db.select().from(lenses)).toHaveLength(21);
    expect((await db.select().from(markets).where(eq(markets.id, 'ca-us')))[0].currency).toBe('USD');
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const v = Array(1536).fill(0);
    v[0] = 1;
    await db.insert(ideas).values({ runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], embedding: v, status: 'candidate' });
    const rows = await db.select({ sim: sql<number>`1 - (${cosineDistance(ideas.embedding, v)})` }).from(ideas);
    expect(rows[0].sim).toBeCloseTo(1);
  });

  it('seeds six consumer lenses and leaves the rest as business', async () => {
    const db = await testDb();
    await seedDefaults(db);
    const rows = await db.select().from(lenses);
    const consumer = rows.filter((l) => l.audience === 'consumer');
    expect(consumer).toHaveLength(6);
    expect(consumer.every((l) => l.id.startsWith('consumer-'))).toBe(true);
    expect(consumer.map((l) => l.id)).toEqual(expect.arrayContaining(['consumer-earn-side', 'consumer-save-auto']));
    expect(rows.filter((l) => l.audience === 'business')).toHaveLength(9);
    expect(CONSUMER_SEGMENTS).toHaveLength(17);
    expect(new Set(CONSUMER_SEGMENTS).size).toBe(CONSUMER_SEGMENTS.length);
    for (const l of consumer) expect(l.promptHint).toMatch(/individual/);
    expect(consumer.find((l) => l.id === 'consumer-ai-chore')?.promptHint).toMatch(/attention/);
  });

  it('seeds the six ambition lenses and sets the two weights, on a fresh and an existing database', async () => {
    const db = await testDb();
    await seedDefaults(db);
    const ids = ['ai-replaces-labour', 'ten-x-incumbent', 'new-capability', 'marketplace-network', 'data-flywheel', 'picks-and-shovels'];
    let rows = await db.select().from(lenses);
    for (const id of ids) expect(rows.find((l) => l.id === id)).toMatchObject({ audience: 'any' });
    expect(rows.find((l) => l.id === 'picks-and-shovels')?.promptHint).toMatch(/changing/);
    // The regulation check kills work that legally needs a licensed professional, so these lenses steer away from it.
    for (const id of ['ai-replaces-labour', 'ten-x-incumbent']) {
      expect(rows.find((l) => l.id === id)?.promptHint).toMatch(/licensed professional/);
      expect(rows.find((l) => l.id === id)?.promptHint).toMatch(/legal, medical, tax or financial advice, engineering sign-off/);
    }
    expect(rows.find((l) => l.id === 'marketplace-network')?.promptHint).toMatch(/software runs the matching, trust and operations/i);
    expect(rows.find((l) => l.id === 'review-gap')?.weight).toBe(0.5);
    expect(rows.find((l) => l.id === 'platform-shockwave')?.weight).toBe(0.5);
    // Existing database: weights null, ambition lenses missing.
    await db.update(lenses).set({ weight: null }).where(eq(lenses.id, 'review-gap'));
    await db.update(lenses).set({ weight: 2 }).where(eq(lenses.id, 'platform-shockwave'));
    await db.delete(lenses).where(eq(lenses.id, 'data-flywheel'));
    await seedDefaults(db);
    rows = await db.select().from(lenses);
    expect(rows).toHaveLength(21);
    expect(rows.find((l) => l.id === 'review-gap')?.weight).toBe(0.5);
    expect(rows.find((l) => l.id === 'platform-shockwave')?.weight).toBe(2);
  });

  it('stores the new idea money and barrier fields', async () => {
    const db = await testDb();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const [idea] = await db.insert(ideas).values({
      runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate',
      audience: 'consumer', businessModel: 'freemium', revenueMechanics: 'free tier, paid upgrade',
      valueToUser: { kind: 'save', amountPerYear: 300, basis: 'x' }, priceHint: { amount: 5, unit: 'month', basis: 'y' },
      barriers: { toStart: 2, toStartWhy: 'a', toCopy: 3, toCopyWhy: 'b', soloBuildable: true }, libraryItemIds: [],
    }).returning();
    expect(idea).toMatchObject({ audience: 'consumer', businessModel: 'freemium', libraryItemIds: [] });
    expect(idea.barriers?.soloBuildable).toBe(true);
  });

  it('stores the needs_review claim status with a review note', async () => {
    const db = await testDb();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const [idea] = await db.insert(ideas).values({ runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' }).returning();
    const [kase] = await db.insert(cases).values({ ideaId: idea.id, slug: 's', title: 'T', sections: {} as never, gateAdvisory: false, model: 'm', promptVersion: 'p' }).returning();
    const [row] = await db.insert(claims).values({
      caseId: kase.id, section: 'competitor', text: 'Acme', sourceUrl: 'https://acme.example', verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.45)',
    }).returning();
    expect(row).toMatchObject({ verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.45)' });
    const [plain] = await db.insert(claims).values({ caseId: kase.id, section: 'evidence', text: 'x', sourceUrl: 'https://x.example' }).returning();
    expect(plain.reviewNote).toBeNull();
  });

  it('stores signal voice and idea functional gap / known incumbents, all nullable (migration 0003)', async () => {
    const db = await testDb();
    const base = { marketId: 'ca-us', source: 'web', title: 't', quote: 'q' };
    const [tagged] = await db.insert(signals).values({ ...base, url: 'https://v.example/1', quoteHash: 'v1', voice: 'vendor' }).returning();
    const [legacy] = await db.insert(signals).values({ ...base, url: 'https://v.example/2', quoteHash: 'v2' }).returning();
    expect(tagged.voice).toBe('vendor');
    expect(legacy.voice).toBeNull();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const idea = { runId: run.id, origin: 'generated' as const, title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' as const };
    const [claimed] = await db.insert(ideas).values({ ...idea, functionalGap: 'no one reconciles X', knownIncumbents: ['Acme', 'Globex'] }).returning();
    const [plain] = await db.insert(ideas).values(idea).returning();
    expect(claimed).toMatchObject({ functionalGap: 'no one reconciles X', knownIncumbents: ['Acme', 'Globex'] });
    expect(plain).toMatchObject({ functionalGap: null, knownIncumbents: null });
  });

  it('rejects duplicate signal url+quote', async () => {
    const db = await testDb();
    const s = { marketId: 'ca-us', source: 'hn', url: 'https://x', title: 't', quote: 'q', quoteHash: 'h' };
    await db.insert(signals).values(s);
    await expect(db.insert(signals).values(s)).rejects.toThrow();
  });

  it('migration 0012 adds the quality columns and idea_reviews, with safe defaults', async () => {
    const db = await testDb();
    type Col = { column_name: string; is_nullable: string; column_default: string | null };
    const cols = async (t: string) => ((await db.execute(sql`select column_name, is_nullable, column_default from information_schema.columns where table_name = ${t}`)) as unknown as { rows: Col[] }).rows;
    const ideaCols = await cols('ideas');
    for (const c of ['owner_rating', 'owner_tags', 'owner_rated_at', 'edge', 'scale']) {
      expect(ideaCols.find((x) => x.column_name === c), c).toMatchObject({ is_nullable: 'YES' });
    }
    expect((await cols('lenses')).find((x) => x.column_name === 'weight')).toMatchObject({ is_nullable: 'YES' });
    const kind = (await cols('signals')).find((x) => x.column_name === 'kind');
    expect(kind).toMatchObject({ is_nullable: 'NO' });
    expect(kind!.column_default).toContain('pain');
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const [sig] = await db.insert(signals).values({ marketId: 'ca-us', source: 'hn', url: 'https://x.test/k', title: 't', quote: 'q', quoteHash: 'hk' }).returning();
    expect(sig!.kind).toBe('pain');
    const [idea] = await db.insert(ideas).values({ runId: run!.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' }).returning();
    expect(idea).toMatchObject({ ownerRating: null, ownerTags: null, ownerRatedAt: null, edge: null, scale: null });
    const review = { ideaId: idea!.id, scale: 3, edge: 4, novelty: 2, niche: 1, reasons: {}, model: 'm', promptVersion: 'review.v1' };
    await db.insert(ideaReviews).values(review);
    await expect(db.insert(ideaReviews).values(review)).rejects.toThrow();
    await expect(db.insert(ideaReviews).values({ ...review, promptVersion: 'v2', edge: 6 })).rejects.toThrow();
    await expect(db.insert(ideaReviews).values({ ...review, promptVersion: 'v3', niche: 0 })).rejects.toThrow();
    await db.insert(ideaReviews).values({ ...review, promptVersion: 'review.v2' });
  });

  it('migration 0013 adds scale columns and the scale gate check, additively', async () => {
    const db = await testDb();
    type Col = { column_name: string; is_nullable: string; data_type: string };
    const cols = ((await db.execute(sql`select column_name, is_nullable, data_type from information_schema.columns where table_name = 'ideas'`)) as unknown as { rows: Col[] }).rows;
    for (const c of ['scale_estimate', 'scale_result']) {
      expect(cols.find((x) => x.column_name === c), c).toMatchObject({ is_nullable: 'YES', data_type: 'jsonb' });
    }
    expect(cols.find((x) => x.column_name === 'scale')).toBeDefined();
    const labels = ((await db.execute(sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'gate_check'`)) as unknown as { rows: { enumlabel: string }[] }).rows.map((r) => r.enumlabel);
    expect(labels).toEqual(expect.arrayContaining(['generic', 'regulation', 'control', 'autonomy', 'reachability', 'evidence', 'scale']));
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const [idea] = await db.insert(ideas).values({ runId: run!.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' }).returning();
    expect(idea).toMatchObject({ scaleEstimate: null, scaleResult: null });
  });

  it('migration 0014 adds finds, the find kind and the new fetch routes, additively', async () => {
    const db = await testDb();
    const enumLabels = async (name: string) =>
      ((await db.execute(sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = ${name} order by e.enumsortorder`)) as unknown as { rows: { enumlabel: string }[] }).rows.map((r) => r.enumlabel);
    expect(await enumLabels('knowledge_kind')).toEqual(['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market', 'find']);
    expect(await enumLabels('fetch_via')).toEqual(['direct', 'archive', 'browser', 'real_browser', 'scraper']);
    expect(await enumLabels('find_status')).toEqual(['queued', 'capturing', 'done', 'failed']);
    expect(await enumLabels('find_source')).toEqual(['telegram', 'paste']);
    const [f] = await db.insert(finds).values({ url: 'https://example.com/x', platform: 'other', source: 'paste' }).returning();
    expect(f).toMatchObject({ status: 'queued', note: null, knowledgeItemId: null, warnings: [], capturedAt: null });
    await expect(db.insert(finds).values({ url: 'https://example.com/x', platform: 'other', source: 'telegram' })).rejects.toThrow();
    // The migration only adds: its SQL never drops, renames or alters an existing column type.
    const migration = readFileSync(join(__dirname, '..', '..', 'drizzle', readdirSync(join(__dirname, '..', '..', 'drizzle')).find((n) => n.startsWith('0014_'))!), 'utf8');
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
  });
});

describe('seed sectors', () => {
  const NEW = ['logistics and freight', 'construction and trades', 'healthcare clinics', 'education and tutoring'];
  it('are present on a fresh database', async () => {
    const db = await testDb();
    await seedDefaults(db);
    const [m] = await db.select().from(markets).where(eq(markets.id, 'ca-us'));
    for (const x of NEW) expect(m!.sectors).toContain(x);
  });
  it('are added to an existing database once, keeping its own edits', async () => {
    const db = await testDb();
    await seedDefaults(db);
    await db.update(markets).set({ sectors: ['my own sector', 'HVAC'] }).where(eq(markets.id, 'ca-us'));
    await seedDefaults(db);
    await seedDefaults(db);
    const [m] = await db.select().from(markets).where(eq(markets.id, 'ca-us'));
    expect(m!.sectors.slice(0, 2)).toEqual(['my own sector', 'HVAC']);
    for (const x of NEW) expect(m!.sectors.filter((s) => s === x)).toHaveLength(1);
  });
  it('never re-add a default sector the owner removed (only the bench-v3 sectors are appended)', async () => {
    const db = await testDb();
    await seedDefaults(db);
    await db.update(markets).set({ sectors: ['my own sector', 'HVAC'] }).where(eq(markets.id, 'ca-us'));
    await seedDefaults(db);
    const [m] = await db.select().from(markets).where(eq(markets.id, 'ca-us'));
    expect(m!.sectors).toEqual(['my own sector', 'HVAC', ...NEW]);
  });
});
