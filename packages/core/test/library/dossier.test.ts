import { describe, expect, it } from 'vitest';
import { buildDossier, type DossierItem } from '../../src/library/dossier';
import type { Collected } from '../../src/research/collect';
import type { CallCtx, ModelRouter } from '../../src/llm/types';

const CTX: CallCtx = { runId: null, promptVersion: 'dossier.v1' };
const PRICING_LINE = 'Plans start at 49 dollars per seat per month for small teams.';
const HOME = `Acme Billing helps plumbers send invoices. ${PRICING_LINE} Trusted by hundreds of trade businesses across Canada.`;
const FUNDING = 'Acme Billing raised a 4 million dollar seed round led by Maple Ventures in March 2023.';
const LAUNCH = 'https://news.example.com/acme-launch';

const item = (o: Partial<DossierItem> = {}): DossierItem => ({
  id: 'i1', title: 'Acme Billing', summary: 'Invoicing for plumbers.',
  facts: { name: 'Acme Billing', whatItDoes: 'invoices', businessModel: 'unknown', outcome: 'active' },
  sourceUrls: [LAUNCH], ...o,
});

type Spec = { pages: Record<string, string>; search?: Record<string, string[]>; extract?: unknown; extractFails?: boolean };
function setup(spec: Spec) {
  const fetched: string[] = [];
  const researched: string[] = [];
  const collectPage = async (url: string): Promise<Collected> => {
    fetched.push(url);
    const text = spec.pages[url];
    return text === undefined ? { failed: 'http_404' } : { text, title: 't', finalUrl: url, via: 'direct' };
  };
  const router = {
    modelFor: () => 'm',
    async text() { throw new Error('unused'); },
    async embed() { throw new Error('unused'); },
    async research(_s: unknown, req: { prompt: string }) {
      researched.push(req.prompt);
      const key = Object.keys(spec.search ?? {}).find((k) => req.prompt.includes(k));
      return { text: '', sources: (key ? spec.search![key]! : []).map((url) => ({ url })) };
    },
    async structured(_s: unknown, req: { schema: { parse(v: unknown): unknown } }) {
      if (spec.extractFails) throw new Error('model down');
      return req.schema.parse(spec.extract ?? {});
    },
  } as unknown as ModelRouter;
  return { fetched, researched, deps: { collectPage, router, ctx: CTX } };
}

const SEARCH = { 'funding OR acquired': ['https://news.example.com/acme-funding'] };

describe('buildDossier', () => {
  it('keeps a field only when its quote is verbatim in a fetched page, and drops the rest', async () => {
    const s = setup({
      pages: { [LAUNCH]: 'Acme Billing launched. Tradespeople pay monthly.', 'https://news.example.com/acme-funding': FUNDING, 'https://acmebilling.com/': HOME },
      search: { ...SEARCH, 'official website': ['https://acmebilling.com/'] },
      extract: {
        pricingUnit: { value: 'per seat per month', quote: PRICING_LINE },
        priceRange: { value: '49 to 999 dollars', quote: 'Enterprise plans cost up to 999 dollars per month for large firms.' },
        funding: { stage: 'seed', amount: '4 million dollars', date: '2023-03', quote: FUNDING },
        people: [],
      },
    });
    const r = await buildDossier(item(), s.deps);
    expect(r.status).toBe('done');
    expect(r.facts).toMatchObject({ pricingUnit: 'per seat per month', funding: { stage: 'seed', amount: '4 million dollars' } });
    expect(r.facts).not.toHaveProperty('priceRange');
    expect(r.quotes).toEqual(expect.arrayContaining([PRICING_LINE, FUNDING]));
    expect(r.quotes).not.toContain('Enterprise plans cost up to 999 dollars per month for large firms.');
  });

  it('is unmatched when no fetched page names the company, with no facts and no extraction', async () => {
    const s = setup({
      pages: { [LAUNCH]: 'Totally different widget maker page about gardening supplies and more.', 'https://news.example.com/acme-funding': 'Parked domain: this domain is for sale, contact the registrar today.' },
      search: SEARCH,
      extract: { whoPays: { value: 'x', quote: 'Totally different widget maker page about gardening supplies' } },
    });
    const r = await buildDossier(item(), s.deps);
    expect(r.status).toBe('unmatched');
    expect(r.facts).toBeUndefined();
  });

  it('is failed when nothing could be fetched, and when the model fails', async () => {
    expect((await buildDossier(item(), setup({ pages: {} }).deps)).status).toBe('failed');
    const s = setup({ pages: { [LAUNCH]: HOME }, extractFails: true });
    expect((await buildDossier(item(), s.deps)).status).toBe('failed');
  });

  it('never lets a founder name reach the facts, and strips named people the model reports', async () => {
    const s = setup({
      pages: { [LAUNCH]: `Acme Billing was founded by Jane Smith. ${PRICING_LINE}` },
      extract: {
        moat: { value: 'Built by Jane Smith, a plumber, with a deep trade network', quote: 'Acme Billing was founded by Jane Smith. Plans start at 49 dollars per seat' },
        whoPays: { value: 'Small plumbing firms; co-founder John Doe says owners buy', quote: PRICING_LINE },
        people: ['Jane Smith'],
      },
    });
    const r = await buildDossier(item({ summary: 'Jane Smith built invoicing.' }), s.deps);
    const text = JSON.stringify([r.facts, r.summary, r.quotes]);
    expect(text).not.toContain('Jane Smith');
    expect(text).not.toContain('John Doe');
    expect(r.facts?.whoPays).toContain('Small plumbing firms');
  });

  it('drops names the model did not report: no stored quote, field or summary holds a cued or name-like person, and company names survive', async () => {
    const line = 'Acme Billing is loved by plumbers, said Jane Smith, a customer in Toronto. Plans start at 49 dollars per seat.';
    const s = setup({
      pages: { [LAUNCH]: `${line} ${FUNDING} Backed by Founders Fund.` },
      extract: {
        useCases: { value: ['Invoicing for plumbers'], quote: 'Acme Billing is loved by plumbers, said Jane Smith, a customer in Toronto.' },
        moat: { value: 'Praised by Jane Smith for speed', quote: 'Plans start at 49 dollars per seat.x' },
        whoPays: { value: 'Small plumbing firms', quote: 'Acme Billing is loved by plumbers, said Jane Smith, a customer in Toronto.' },
        funding: { stage: 'seed', amount: '4 million dollars', quote: FUNDING },
        comps: { value: ['Founders Fund portfolio rival', 'Acme Billing'], quote: 'Acme Billing is loved by plumbers, said Jane Smith, a customer in Toronto.' },
        people: [],
      },
    });
    const r = await buildDossier(item({ summary: 'Acme Billing, praised by Jane Smith, sends invoices.' }), s.deps);
    const stored = JSON.stringify([r.facts, r.summary, r.quotes, r.sources]);
    expect(stored).not.toContain('Jane Smith');
    expect(r.facts?.whoPays).toBe('Small plumbing firms');
    expect(r.facts?.useCases).toEqual(['Invoicing for plumbers']);
    expect(r.facts).not.toHaveProperty('moat');
    expect(r.quotes).toContain(FUNDING);
    expect(r.facts?.funding).toMatchObject({ stage: 'seed' });
    expect(r.summary).toContain('Acme Billing');
    expect(r.facts?.comps).toEqual(['Founders Fund portfolio rival', 'Acme Billing']);
  });

  it('never requests a never-fetch or banned host', async () => {
    const s = setup({
      pages: { [LAUNCH]: HOME },
      search: { 'funding OR acquired': ['https://www.gamersgetaway.ca/acme', 'https://bing.com/search?q=acme', LAUNCH] },
      extract: {},
    });
    await buildDossier(item({ sourceUrls: ['https://gamersgetaway.ca/x', LAUNCH] }), s.deps);
    expect(s.fetched.some((u) => /gamersgetaway|bing\.com/.test(u))).toBe(false);
  });

  it('searches for a post-mortem only when the outcome is dead', async () => {
    const live = setup({ pages: { [LAUNCH]: HOME }, extract: {} });
    await buildDossier(item(), live.deps);
    expect(live.researched.some((p) => /post-mortem/i.test(p))).toBe(false);
    const dead = setup({ pages: { [LAUNCH]: HOME }, extract: {} });
    await buildDossier(item({ facts: { name: 'Acme Billing', whatItDoes: 'x', businessModel: 'subscription', outcome: 'dead' } }), dead.deps);
    expect(dead.researched.some((p) => /post-mortem/i.test(p))).toBe(true);
  });
});
