import { describe, it, expect } from 'vitest';
import { claims } from '../../src/db/schema';
import { defaultRunConfig } from '../../src/pipeline/types';
import { allowedOfferTerms, offerPrice, verifiedClaimTexts } from '../../src/validation/verified-claims';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

type Db = Awaited<ReturnType<typeof testDb>>;
type Status = 'verified' | 'unsupported' | 'needs_review' | 'unverified' | 'unreachable';

async function setup() {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  const kase = await insertCase(db, idea.id);
  const add = (text: string, verified: Status, section = 'evidence') =>
    db.insert(claims).values({ caseId: kase.id, section, text, sourceUrl: 'https://s.example/a', quote: 'q', verified });
  return { db: db as Db, caseId: kase.id, add };
}

describe('verifiedClaimTexts (P3-R19/R20)', () => {
  it('a text that is unverified in any quotable section is not quotable anywhere', async () => {
    const { db, caseId, add } = await setup();
    await add('Average claim is $310', 'verified', 'evidence');
    await add('Average claim is $310', 'unsupported', 'numbers');
    expect(await verifiedClaimTexts(db, caseId)).toEqual([]);
  });

  it('a text verified in both sections is quotable once', async () => {
    const { db, caseId, add } = await setup();
    await add('Average claim is $310', 'verified', 'evidence');
    await add('Average claim is $310', 'verified', 'numbers');
    expect(await verifiedClaimTexts(db, caseId)).toEqual(['Average claim is $310']);
  });

  it('texts differing only by whitespace or invisible characters are one text', async () => {
    const { db, caseId, add } = await setup();
    await add('Average  claim is\n$310', 'verified', 'evidence');
    await add('Average claim​ is $310 ', 'needs_review', 'numbers');
    expect(await verifiedClaimTexts(db, caseId)).toEqual([]);

    const s2 = await setup();
    await s2.add('Brokers lose‮ 12%', 'verified');
    await s2.add(' Brokers  lose 12%', 'verified', 'numbers');
    expect(await verifiedClaimTexts(s2.db, s2.caseId)).toEqual(['Brokers lose 12%']);
  });

  it('ignores non-quotable sections and every non-verified status', async () => {
    const { db, caseId, add } = await setup();
    await add('Signal text', 'verified', 'signal');
    for (const s of ['unsupported', 'needs_review', 'unverified', 'unreachable'] as const) await add(`claim ${s}`, s);
    await add('Good claim', 'verified');
    expect(await verifiedClaimTexts(db, caseId)).toEqual(['Good claim']);
  });
});

describe('offerPrice / allowedOfferTerms', () => {
  const sections = (amount: unknown, per?: unknown) => ({ summary: { price: { amount, per } } });
  it('states the case price with its currency sign, as the case export does', () => {
    expect(offerPrice(sections(1, 'load processed'))).toBe('$1 per load processed');
    expect(offerPrice(sections(1.5, 'invoice'))).toBe('$1.50 per invoice');
    expect(offerPrice(sections(1200, 'month'))).toBe('$1,200 per month');
    expect(offerPrice(sections(99))).toBe('$99');
    expect(allowedOfferTerms(sections(1, 'load processed'))).toEqual(['$1 per load processed']);
  });
  it('gives nothing without a finite numeric price', () => {
    for (const s of [sections('99', 'month'), sections(Number.NaN, 'month'), {}, null]) {
      expect(offerPrice(s)).toBe('');
      expect(allowedOfferTerms(s)).toEqual([]);
    }
  });
});
