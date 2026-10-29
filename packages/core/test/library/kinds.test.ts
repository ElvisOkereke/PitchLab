import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '../helpers/db';
import { KNOWLEDGE_KINDS, SLICE_A_KINDS, KIND_LABELS, FactsSchemas, parseFacts } from '../../src/library/kinds';
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

  const trend = { topic: 'pickleball', direction: 'rising', evidence: [{ metric: 'Wikipedia monthly views', value: '+42%', period: 'last 12 months vs the 12 before' }], window: '36 months', basis: 'measured' };
  const rule = { title: 'Junk fee rule', change: 'Bans hidden fees', whoIsAffected: 'Ticket sellers', jurisdiction: 'US-federal', status: 'final', effectiveDate: '2026-05-12', publishedDate: null };
  const market = { segment: 'dog walking', geography: 'CA', sizeClues: [{ metric: 'revenue', value: '1.2', unit: 'billion USD', year: '2024' }], growthClues: [] };

  it('trend facts: 1 to 6 evidence items, known direction and basis', () => {
    expect(parseFacts('trend', trend)).toEqual(trend);
    const ev = trend.evidence[0]!;
    expect(FactsSchemas.trend.safeParse({ ...trend, evidence: [] }).success).toBe(false);
    expect(FactsSchemas.trend.safeParse({ ...trend, evidence: Array(6).fill(ev) }).success).toBe(true);
    expect(FactsSchemas.trend.safeParse({ ...trend, evidence: Array(7).fill(ev) }).success).toBe(false);
    expect(FactsSchemas.trend.safeParse({ ...trend, direction: 'sideways' }).success).toBe(false);
    expect(FactsSchemas.trend.safeParse({ ...trend, basis: 'guessed' }).success).toBe(false);
    expect(() => parseFacts('trend', {})).toThrow(/Invalid trend facts/);
  });

  it('rule_change facts: ISO dates or null, known status', () => {
    expect(parseFacts('rule_change', rule)).toEqual(rule);
    expect(FactsSchemas.rule_change.safeParse({ ...rule, effectiveDate: null }).success).toBe(true);
    expect(FactsSchemas.rule_change.safeParse({ ...rule, effectiveDate: 'May 12, 2026' }).success).toBe(false);
    expect(FactsSchemas.rule_change.safeParse({ ...rule, publishedDate: '2026-13-40' }).success).toBe(false);
    expect(FactsSchemas.rule_change.safeParse({ ...rule, status: 'rumoured' }).success).toBe(false);
    expect(FactsSchemas.rule_change.safeParse({ ...rule, effectiveDate: undefined }).success).toBe(false);
  });

  it('market facts: 1 to 8 size clues, 0 to 6 growth clues', () => {
    expect(parseFacts('market', market)).toEqual(market);
    const sc = market.sizeClues[0]!;
    expect(FactsSchemas.market.safeParse({ ...market, sizeClues: [] }).success).toBe(false);
    expect(FactsSchemas.market.safeParse({ ...market, sizeClues: Array(8).fill(sc) }).success).toBe(true);
    expect(FactsSchemas.market.safeParse({ ...market, sizeClues: Array(9).fill(sc) }).success).toBe(false);
    const gc = { metric: 'visitors', change: '+5%', period: '2023-2024' };
    expect(FactsSchemas.market.safeParse({ ...market, growthClues: Array(6).fill(gc) }).success).toBe(true);
    expect(FactsSchemas.market.safeParse({ ...market, growthClues: Array(7).fill(gc) }).success).toBe(false);
  });

  it('KIND_LABELS has a plain label for every kind', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...KNOWLEDGE_KINDS].sort());
    expect(KIND_LABELS.trend).toBe("What's growing or shrinking");
    expect(KIND_LABELS.rule_change).toBe('A rule or platform change');
    expect(KIND_LABELS.market).toBe('Market size clues');
    expect([KIND_LABELS.problem, KIND_LABELS.startup, KIND_LABELS.pricing]).toEqual(['Problems', 'Startups', 'Pricing']);
  });

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
