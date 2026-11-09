import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client';
import { lenses } from '../../../src/db/schema';
import { upsertKnowledgeItem } from '../../../src/library/store';
import { MAX_TOPICS, MIN_TOPICS, planFeedTopics, shortPhrase } from '../../../src/research/feeds/topics';
import { testDb, unit } from '../../helpers/db';

const D1 = new Date('2026-11-08T12:00:00Z');
const D2 = new Date('2026-11-09T12:00:00Z');

let db: Db;
beforeAll(async () => {
  db = await testDb();
  await upsertKnowledgeItem(db, {
    kind: 'trend', title: 'Interest in zebra widgets', summary: 'rising', audience: 'both', countries: [], industries: [], voice: 'neutral',
    facts: { topic: 'zebra widgets', direction: 'rising', evidence: [{ metric: 'views', value: '10', period: '2026' }], window: '2025-2026', basis: 'measured' },
    source: { url: 'https://example.com/zebra', domain: 'example.com', sourceType: 'wikipedia', quoteVerified: false },
  }, unit(1), {});
  await upsertKnowledgeItem(db, {
    kind: 'trend', title: 'Interest in falling things', summary: 'falling', audience: 'both', countries: [], industries: [], voice: 'neutral',
    facts: { topic: 'falling gadgets', direction: 'falling', evidence: [{ metric: 'views', value: '3', period: '2026' }], window: '2025-2026', basis: 'measured' },
    source: { url: 'https://example.com/falling', domain: 'example.com', sourceType: 'wikipedia', quoteVerified: false },
  }, unit(2), {});
});

describe('planFeedTopics', () => {
  it('plans 10 to 20 distinct queries and 3 subreddits', async () => {
    const t = await planFeedTopics(db, D1);
    expect(t.queries.length).toBeGreaterThanOrEqual(MIN_TOPICS);
    expect(t.queries.length).toBeLessThanOrEqual(MAX_TOPICS);
    expect(new Set(t.queries.map((q) => q.toLowerCase())).size).toBe(t.queries.length);
    expect(t.subreddits).toHaveLength(3);
    expect(t.subreddits.every((s) => /^r\/[A-Za-z0-9_]+$/.test(s))).toBe(true);
  });

  it('is the same all day and moves on the next day', async () => {
    const a = await planFeedTopics(db, new Date('2026-11-08T01:00:00Z'));
    const b = await planFeedTopics(db, new Date('2026-11-08T23:00:00Z'));
    expect(b).toEqual(a);
    const c = await planFeedTopics(db, D2);
    expect(c.queries).not.toEqual(a.queries);
    expect(c.subreddits).not.toEqual(a.subreddits);
  });

  it('draws on the market sectors, the active lenses (shortened) and rising trends only', async () => {
    const t = await planFeedTopics(db, D1);
    const patterns = (await db.select().from(lenses)).map((l) => shortPhrase(l.pattern));
    expect(t.queries).toContain('zebra widgets');
    expect(t.queries).not.toContain('falling gadgets');
    expect(t.queries.some((q) => patterns.includes(q))).toBe(true);
    expect(t.queries.every((q) => q.length <= 60)).toBe(true);
  });

  it('shortPhrase keeps six words of letters and digits', () => {
    expect(shortPhrase('A very long lens pattern, with: punctuation! and many words')).toBe('A very long lens pattern with');
    expect(shortPhrase('')).toBe('');
  });
});
