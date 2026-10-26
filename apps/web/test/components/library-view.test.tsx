import type { MissionView } from '@bcg/core/dashboard/missions';
import type { LibraryCoverage, LibraryRow } from '@bcg/core/library/store';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryViewProps } from '@/components/library-view';
import { CHAPTERS } from '@/lib/tour/chapters';

vi.mock('@/actions/library', () => ({
  queueMissionAction: vi.fn(async () => ({})),
  rejectItemAction: vi.fn(async () => {}),
  restoreItemAction: vi.fn(async () => {}),
  saveResearchSettingsAction: vi.fn(async () => ({})),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { LibraryView } = await import('@/components/library-view');

afterEach(cleanup);

const NOW = new Date('2026-10-20T15:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';

function row(o: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id: ID, kind: 'problem', title: 'Invoices chase me', summary: 'Owners chase late invoices by hand.', quote: 'I spend Fridays chasing invoices',
    quoteVerified: true, audience: 'business', countries: ['US', 'CA'], industries: ['retail'], voice: 'operator', status: 'active', sourceCount: 2,
    newestSourceAt: new Date('2026-10-18T15:00:00Z'), updatedAt: NOW, ...o,
  };
}
function coverage(o: Partial<LibraryCoverage> = {}): LibraryCoverage {
  return {
    byKind: { problem: 6, pricing: 3, startup: 1 }, bySourceType: { hn: 7, producthunt: 3 }, byVoice: { operator: 4, neutral: 2, vendor: 1 },
    problemIndependentShare: 0.75, verifiedQuoteShare: 0.5, countries: ['US', 'CA', 'GB'], industries: ['retail', 'hvac'], newest: NOW, oldest: new Date('2026-09-01T00:00:00Z'), ...o,
  };
}
function mission(o: Partial<MissionView> = {}): MissionView {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', topic: 'late invoices', kinds: ['problem'], countries: [], audience: null, origin: 'owner', status: 'succeeded',
    budgetUsd: 2, costUsd: 0.4321, itemsAdded: 5, itemsMerged: 2, warnings: [], error: null, createdAt: NOW, startedAt: NOW, finishedAt: NOW, stalled: false, ...o,
  };
}
function props(o: Partial<LibraryViewProps> = {}): LibraryViewProps {
  return {
    query: { q: '', status: 'active', page: 1 }, rows: [row()], total: 1, coverage: coverage(), item: null, missions: [], typicalCost: null,
    research: { background: false, dailyCapUsd: 5 }, backgroundSpend: 0, now: NOW, ...o,
  };
}

describe('LibraryView results', () => {
  it('shows each entry with kind, title, summary, voice, countries, age, sources and a verified-quote badge', () => {
    const { getByTestId } = render(<LibraryView {...props({ rows: [row(), row({ id: ID.replace('1', '2'), quoteVerified: false, title: 'Second', voice: null })], total: 2 })} />);
    const items = [...getByTestId('library-results').querySelectorAll('li.library-row')];
    expect(items).toHaveLength(2);
    const t = items[0]!.textContent!;
    for (const s of ['problem', 'Invoices chase me', 'Owners chase late invoices by hand.', 'operator', 'US, CA', '2 d ago', '2 sources', 'verified quote']) expect(t).toContain(s);
    expect(items[1]!.textContent).toContain('unverified');
    expect(items[1]!.textContent).not.toContain('verified quote');
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe(`/library?item=${ID}`);
  });

  it('renders a hostile title as text', () => {
    const title = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { getByTestId } = render(<LibraryView {...props({ rows: [row({ title })] })} />);
    const results = getByTestId('library-results');
    expect(results.textContent).toContain(title);
    expect(results.querySelector('img, script')).toBeNull();
  });

  it('the filter form is a GET form that reflects the query and lists every filter', () => {
    const { getByTestId } = render(<LibraryView {...props({ query: { q: 'invoices', kind: 'pricing', voice: 'operator', country: 'CA', age: 30, status: 'all', page: 1 } })} />);
    const f = getByTestId('library-filters') as HTMLFormElement;
    expect(f.method).toBe('get');
    expect(f.getAttribute('action')).toBe('/library');
    const get = (n: string) => f.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`)!;
    expect(get('q').value).toBe('invoices');
    expect(get('kind').value).toBe('pricing');
    expect(get('voice').value).toBe('operator');
    expect(get('country').value).toBe('CA');
    expect(get('age').value).toBe('30');
    expect(get('status').value).toBe('all');
    for (const n of ['audience', 'source']) expect(get(n)).toBeTruthy();
    expect([...(get('source') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'hn', 'producthunt']);
    expect([...(get('country') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'CA', 'GB', 'US']);
    for (const el of f.querySelectorAll('input[name], select')) expect(f.querySelector(`label[for="${el.id}"]`), el.id).toBeTruthy();
  });

  it('pages 50 at a time and keeps the filters in the pager links', () => {
    const { getByTestId } = render(<LibraryView {...props({ query: { q: '', kind: 'problem', status: 'active', page: 2 }, total: 120 })} />);
    const pager = getByTestId('library-pager');
    expect(pager.textContent).toContain('Page 2 of 3');
    expect([...pager.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/library?kind=problem', '/library?kind=problem&page=3']);
  });

  it('an empty library points at the missions form; an empty filter result does not', () => {
    const empty = render(<LibraryView {...props({ rows: [], total: 0, coverage: coverage({ byKind: {}, countries: [] }) })} />);
    expect(empty.container.textContent).toContain('The library is empty. Start a research mission below.');
    cleanup();
    const none = render(<LibraryView {...props({ rows: [], total: 0, query: { q: 'zzz', status: 'active', page: 1 } })} />);
    expect(none.container.textContent).not.toContain('The library is empty');
    expect(none.container.textContent).toContain('No entries match these filters.');
  });
});

describe('LibraryView entry detail', () => {
  const item = {
    ...row(), facts: { persona: 'shop owner', pricePoints: [{ amount: 10, currency: 'USD', unit: 'month' }], frequencyOrCost: '<b>weekly</b>' },
    sources: [
      { id: 's1', url: 'https://news.example/post/1', domain: 'news.example', sourceType: 'hn', publishedAt: new Date('2026-10-18T00:00:00Z'), fetchedAt: NOW, quote: 'I spend Fridays chasing invoices', quoteVerified: true },
      { id: 's2', url: 'javascript:alert(1)', domain: 'bad.example', sourceType: 'web', publishedAt: null, fetchedAt: NOW, quote: null, quoteVerified: false },
    ],
  };

  it('shows the quote, source links (safe only), facts as a definition list and Reject with the return URL', () => {
    const { getByTestId } = render(<LibraryView {...props({ item, query: { q: '', status: 'active', page: 1, item: ID } })} />);
    const d = getByTestId('library-detail');
    expect(d.textContent).toContain('I spend Fridays chasing invoices');
    const links = [...d.querySelectorAll('a')].filter((a) => a.getAttribute('target') === '_blank');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://news.example/post/1']);
    expect(d.querySelector('a[href^="javascript"]')).toBeNull();
    const dl = d.querySelector('dl')!;
    expect(dl.textContent).toContain('persona');
    expect(dl.textContent).toContain('shop owner');
    expect(dl.textContent).toContain('<b>weekly</b>');
    expect(dl.querySelector('b')).toBeNull();
    const form = d.querySelector('form')!;
    expect(within(form as HTMLElement).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(form.querySelector('input[name="id"]')!.getAttribute('value')).toBe(ID);
    expect(form.querySelector('input[name="returnTo"]')!.getAttribute('value')).toBe(`/library?item=${ID}`);
  });

  it('a rejected entry offers Restore instead', () => {
    const { getByTestId } = render(<LibraryView {...props({ item: { ...item, status: 'rejected' }, query: { q: '', status: 'all', page: 1, item: ID } })} />);
    const d = within(getByTestId('library-detail'));
    expect(d.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(d.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});

describe('LibraryView coverage', () => {
  it('shows the counts next to the health targets', () => {
    const { getByTestId } = render(<LibraryView {...props()} />);
    const t = getByTestId('library-coverage').textContent!;
    expect(t).toContain('10 entries');
    expect(t).toMatch(/problem entries in operator or neutral voice.*75%.*60% or more/i);
    expect(t).toMatch(/countries.*3.*10 or more/i);
    expect(t).toContain('hn 7');
    expect(t).toContain('operator 4');
  });

  it('shows a dash when there is nothing to measure yet', () => {
    const { getByTestId } = render(<LibraryView {...props({ coverage: coverage({ problemIndependentShare: null, verifiedQuoteShare: null, countries: [] }) })} />);
    expect(getByTestId('library-coverage').textContent).toMatch(/operator or neutral voice.*–/i);
  });
});

describe('LibraryView missions', () => {
  it('has the tour anchor, the form with its cost hint, and the typical cost when known', () => {
    const none = render(<LibraryView {...props()} />);
    const card = none.getByTestId('library-missions');
    expect(card.getAttribute('data-tour')).toBe('library-missions');
    expect(within(card).getByRole('button', { name: 'Start research mission' })).toBeTruthy();
    expect(card.textContent).toContain('up to $2.00');
    expect(card.textContent).not.toContain('Typical cost');
    cleanup();
    const some = render(<LibraryView {...props({ typicalCost: 0.5 })} />);
    expect(some.getByTestId('library-missions').textContent).toContain('Typical cost of recent missions: $0.50');
  });

  it('the form has topic, one checkbox per kind, countries, audience and budget', () => {
    const { getByTestId } = render(<LibraryView {...props()} />);
    const f = getByTestId('mission-form');
    expect([...f.querySelectorAll('input[name="kinds"]')].map((i) => (i as HTMLInputElement).value)).toEqual(['problem', 'startup', 'pricing']);
    for (const n of ['topic', 'countries', 'audience', 'budgetUsd']) expect(f.querySelector(`[name="${n}"]`), n).toBeTruthy();
    const b = f.querySelector<HTMLInputElement>('[name="budgetUsd"]')!;
    expect([b.min, b.max, b.value]).toEqual(['0.5', '10', '2']);
    expect(f.querySelector<HTMLInputElement>('[name="topic"]')!.maxLength).toBe(200);
  });

  it('lists missions with status, items added and merged, cost, error, and warnings inside a details element', () => {
    const ms = [
      mission({ warnings: ['hn: 429, skipped', '<b>x</b>'] }),
      mission({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'failed', error: 'budget <i>gone</i>', topic: '<script>x</script>', itemsAdded: 0, itemsMerged: 0 }),
      mission({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'running', stalled: true }),
    ];
    const { getByTestId } = render(<LibraryView {...props({ missions: ms })} />);
    const rows = [...getByTestId('mission-list').querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('late invoices');
    expect(rows[0]!.textContent).toContain('succeeded');
    expect(rows[0]!.querySelector('[data-label="Added"]')!.textContent).toBe('5');
    expect(rows[0]!.querySelector('[data-label="Merged"]')!.textContent).toBe('2');
    expect(rows[0]!.querySelector('[data-label="Cost"]')!.textContent).toBe('$0.43');
    const det = rows[0]!.querySelector('details')!;
    expect(det.querySelector('summary')!.textContent).toBe('2 warnings');
    expect(det.textContent).toContain('hn: 429, skipped');
    expect(det.textContent).toContain('<b>x</b>');
    expect(det.querySelector('b')).toBeNull();
    expect(rows[1]!.textContent).toContain('budget <i>gone</i>');
    expect(rows[1]!.textContent).toContain('<script>x</script>');
    expect(rows[1]!.querySelector('i, script')).toBeNull();
    expect(rows[2]!.textContent).toContain('stalled');
  });

  it('states that background research is off, or the spend today when on', () => {
    const off = render(<LibraryView {...props()} />);
    expect(off.getByTestId('library-missions').textContent).toContain('Background research is off (turn it on in Settings)');
    cleanup();
    const on = render(<LibraryView {...props({ research: { background: true, dailyCapUsd: 5 }, backgroundSpend: 1.234 })} />);
    expect(on.getByTestId('library-missions').textContent).toContain('Background research is on: $1.23 of $5.00 spent today');
  });

  it('refreshes itself only while a mission is queued or running', () => {
    // AutoRefresh renders nothing; it is mounted when busy, so the view reports it through a data attribute.
    const idle = render(<LibraryView {...props({ missions: [mission()] })} />);
    expect(idle.getByTestId('library-missions').getAttribute('data-refreshing')).toBe('false');
    cleanup();
    const busy = render(<LibraryView {...props({ missions: [mission({ status: 'queued' })] })} />);
    expect(busy.getByTestId('library-missions').getAttribute('data-refreshing')).toBe('true');
  });
});

describe('markup validity', () => {
  it('no details element sits inside a paragraph or heading (the parser would close it early)', () => {
    const { container } = render(<LibraryView {...props({ item: null })} />);
    expect(container.querySelectorAll('p details, h1 details, h2 details')).toHaveLength(0);
    expect(container.querySelectorAll('details.help-tip').length).toBeGreaterThan(0);
  });
});

describe('tour', () => {
  it('has one library step in Generate, before the queue form, on /library', () => {
    const steps = CHAPTERS.generate.steps;
    const i = steps.findIndex((s) => s.target === 'library-missions');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(steps.findIndex((s) => s.target === 'queue-seed'));
    expect(steps[i]!.route).toBe('/library');
    expect(steps[i]!.body).toMatch(/library/);
    expect(steps[i]!.body).toMatch(/cost/);
  });
});
