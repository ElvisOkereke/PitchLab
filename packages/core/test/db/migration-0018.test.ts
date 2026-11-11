import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { gateCheck, lenses, markets } from '../../src/db/schema';
import { MARKET_TIERS } from '../../src/pipeline/market-tiers';
import { testDb } from '../helpers/db';

const SPEC_SECTORS = [
  'insurance carriers', 'banks and credit unions', 'health systems and hospitals', 'health insurers and payers',
  'pharma and life sciences', 'utilities and energy', 'telecom', 'manufacturing', 'chemicals',
  'aerospace and defence suppliers', 'government agencies', 'universities',
  'logistics shippers and 3PLs', 'wholesale and distribution', 'commercial real estate', 'construction general contractors',
  'engineering firms', 'staffing agencies', 'law firms', 'accounting firms', 'HR and payroll', 'fintech and payments',
  'B2B SaaS companies', 'data and AI teams', 'cybersecurity', 'ecommerce marketplaces', 'media and publishers',
  'automotive dealers', 'agriculture and food processing', 'mining', 'specialty retail chains', 'hospitality groups',
  'franchise groups', 'multi-location clinics', 'field services', 'ecommerce brands',
];

describe('migration 0018 (diversity)', () => {
  it('inserts market broad with every spec sector and tier, and leaves ca-us untiered', async () => {
    const db = await testDb();
    const [m] = await db.select().from(markets).where(eq(markets.id, 'broad'));
    expect(m).toMatchObject({ name: 'North America, all tiers', countries: ['CA', 'US'], language: 'en', currency: 'USD' });
    expect([...m!.sectors].sort()).toEqual([...SPEC_SECTORS].sort());
    expect(Object.keys(MARKET_TIERS.broad!).sort()).toEqual([...SPEC_SECTORS].sort());
    expect(Object.values(MARKET_TIERS.broad!).filter((t) => t === 'enterprise')).toHaveLength(12);
    expect(Object.values(MARKET_TIERS.broad!).filter((t) => t === 'mid')).toHaveLength(20);
    expect(Object.values(MARKET_TIERS.broad!).filter((t) => t === 'small')).toHaveLength(4);
    expect(MARKET_TIERS['ca-us']).toBeUndefined();
    expect((await db.select().from(markets).where(eq(markets.id, 'ca-us')))).toHaveLength(1);
  });

  it('adds the buyers gate check, sets the lens weights and adds industry-shift, additively', async () => {
    const db = await testDb();
    const labels = ((await db.execute(sql`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'gate_check' order by e.enumsortorder`)) as unknown as { rows: { enumlabel: string }[] }).rows.map((r) => r.enumlabel);
    expect(labels.at(-1)).toBe('buyers');
    expect([...gateCheck.enumValues]).toEqual(labels);
    const rows = await db.select().from(lenses);
    const w = (id: string) => rows.find((l) => l.id === id)?.weight;
    for (const id of ['money-leak', 'silent-failure', 'review-gap', 'platform-shockwave']) expect(w(id)).toBe(0.5);
    for (const id of ['new-capability', 'ai-replaces-labour', 'data-flywheel', 'compliance-demand', 'picks-and-shovels', 'ten-x-incumbent', 'industry-shift']) expect(w(id)).toBe(1.5);
    expect(rows.find((l) => l.id === 'industry-shift')).toMatchObject({
      audience: 'business', active: true,
      pattern: 'A structural change across a large industry (regulation, technology, labour, capital) that forces thousands of companies to change how they work; build what they will all need.',
    });

    const dir = join(__dirname, '..', '..', 'drizzle');
    const migration = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith('0018_'))!), 'utf8');
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|\bDELETE\b|\bTRUNCATE\b/i);
    expect(migration).toMatch(/ADD VALUE 'buyers'/);
  });
});
