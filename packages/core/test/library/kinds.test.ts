import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '../helpers/db';
import { KNOWLEDGE_KINDS, SLICE_A_KINDS, FactsSchemas, parseFacts } from '../../src/library/kinds';
import { knowledgeItems, knowledgeSources, researchMissions, signals, dataCalls } from '../../src/db/schema';
import { logDataCall } from '../../src/tools/data-calls';

const valid = {
  problem: { persona: 'bookkeeper' },
  startup: { name: 'Acme', whatItDoes: 'x', businessModel: 'saas', outcome: 'dead' },
  pricing: { product: 'p', pricePoints: [{ amount: 10, currency: 'USD', unit: 'month' }], buyer: 'smb', complaints: [] },
} as const;

describe('library kinds', () => {
  it('lists six kinds and three slice A kinds', () => {
    expect(KNOWLEDGE_KINDS).toEqual(['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market']);
    expect(SLICE_A_KINDS).toEqual(['problem', 'startup', 'pricing']);
  });

  for (const kind of SLICE_A_KINDS) {
    it(`${kind} facts accept a valid sample and reject a missing field`, () => {
      expect(FactsSchemas[kind].safeParse(valid[kind]).success).toBe(true);
      expect(parseFacts(kind, valid[kind])).toEqual(valid[kind]);
      expect(FactsSchemas[kind].safeParse({}).success).toBe(false);
      expect(() => parseFacts(kind, {})).toThrow(/Invalid .* facts/);
    });
  }

  it('rejects a bad startup outcome', () => {
    expect(FactsSchemas.startup.safeParse({ ...valid.startup, outcome: 'zombie' }).success).toBe(false);
  });

  it('stores items, sources, missions and mission-attributed data calls', async () => {
    const db = await testDb();
    const [m] = await db.insert(researchMissions).values({ topic: 't', kinds: ['problem'], countries: ['US'], budgetUsd: '2', origin: 'owner' }).returning();
    expect(m).toMatchObject({ status: 'queued', itemsAdded: 0, itemsMerged: 0, warnings: [], costUsd: '0' });
    const [item] = await db.insert(knowledgeItems).values({
      kind: 'problem', title: 't', summary: 's', audience: 'business', countries: ['US'], industries: [], facts: {}, contentHash: 'h', missionId: m.id,
    }).returning();
    expect(item).toMatchObject({ status: 'active', quoteVerified: false, embedding: null });
    await db.insert(knowledgeSources).values({ itemId: item.id, url: 'https://a.test', domain: 'a.test', sourceType: 'web', quoteVerified: false });
    await expect(db.insert(knowledgeSources).values({ itemId: item.id, url: 'https://a.test', domain: 'a.test', sourceType: 'web', quoteVerified: false })).rejects.toThrow();
    await logDataCall(db, { runId: null, missionId: m.id, provider: 'x', endpoint: 'e', ok: true });
    const rows = await db.select().from(dataCalls).where(eq(dataCalls.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(signals.knowledgeItemId).toBeDefined();
  });
});
