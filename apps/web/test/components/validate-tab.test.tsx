import type { OutreachDraftRow, OutreachEventRow } from '@bcg/core/dashboard/validate-view';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTILE, caseViewFixture } from '../helpers/case-fixture';
import { landingCopyFixture, packFixture, prospectRow, validateViewFixture } from '../helpers/validate-fixture';

vi.mock('@/actions/outreach', () => ({ markOutreachAction: vi.fn(async () => ({})) }));

const { ValidateTab } = await import('@/components/tabs/validate');

afterEach(cleanup);

const NOW = new Date('2026-10-19T12:00:00Z');
const draft = (prospectId: string, kind: OutreachDraftRow['kind'], subject: string, body: string): OutreachDraftRow => ({
  id: `${prospectId.slice(0, 30)}${kind.length}`, prospectId, kind, subject, body, model: 'm', promptVersion: 'p', createdAt: NOW,
});

describe('ValidateTab', () => {
  it('validate tab shows the not-generated state without a pack', () => {
    const { container } = render(<ValidateTab view={caseViewFixture()} validate={validateViewFixture({ pack: null, checklist: null })} page={1} />);
    expect(container.textContent).toContain('Validation pack not generated yet. Run: npm run gen -- validate lead-flow-verification');
  });

  it('validate tab never renders landing html and badges CASL basis', () => {
    const a = prospectRow({ caslBasis: 'self_published' });
    const b = prospectRow({ caslBasis: 'third_party', email: null });
    const c = prospectRow({ caslBasis: 'unknown', name: HOSTILE, website: 'javascript:alert(1)', fitReason: HOSTILE });
    const landing = {
      copy: { ...landingCopyFixture, headline: HOSTILE }, publishedUrl: 'https://pages.example/lead-flow', updatedAt: NOW, htmlBytes: 2048,
      // Never part of ValidateView; present here to prove the tab would not render it even if it were.
      html: '<p id="raw-landing">RAW LANDING HTML</p>',
    };
    const { container, getByTestId } = render(
      <ValidateTab view={caseViewFixture()} validate={validateViewFixture({ prospects: { rows: [a, b, c], total: 3 }, landing })} page={1} />,
    );
    expect(container.querySelector('iframe, img, script, style, object, embed, #raw-landing')).toBeNull();
    expect(container.textContent).not.toContain('RAW LANDING HTML');

    const land = getByTestId('landing');
    expect(land.textContent).toContain(HOSTILE);
    expect(land.textContent).toContain('2.0 KB');
    expect(land.querySelector('a')?.getAttribute('href')).toBe('https://pages.example/lead-flow');

    const rows = [...getByTestId('prospects').querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('.badge')?.className)).toEqual([
      expect.stringContaining('badge-ok'), expect.stringContaining('badge-warn'), expect.stringContaining('badge-bad'),
    ]);
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe(new URL(a.website).href);
    expect(rows[2]!.querySelector('a')).toBeNull();
    expect(rows[2]!.textContent).toContain('javascript:alert(1)');
    expect(rows[1]!.textContent).toContain('no email');
  });

  it('shows the pack documents, checklist chips and outreach counts', () => {
    const validate = validateViewFixture();
    validate.counts.prospects = 12;
    validate.counts.withEmail = 9;
    validate.counts.events.sent = { events: 7, prospects: 6 };
    const { container, getByTestId } = render(<ValidateTab view={caseViewFixture()} validate={validate} page={1} />);
    expect(container.textContent).toContain('A lead-flow checker for agencies');
    expect(container.textContent).toContain('An agency with 40 client sites');
    expect(container.textContent).toContain('Question 8?');
    const gates = [...getByTestId('checklist').querySelectorAll('li')];
    expect(gates[0]!.textContent).toContain('Send 50 emails');
    expect(gates[0]!.querySelector('.badge')?.textContent).toBe('pass');
    expect(gates[1]!.querySelector('.badge')?.textContent).toBe('pending');
    expect(gates[1]!.textContent).toContain('1 / 3');
    const counts = getByTestId('outreach-counts').textContent!;
    expect(counts).toContain('12 prospects');
    expect(counts).toContain('9 with email');
    expect(counts).toContain('sent: 6');
  });

  it("lists each prospect's drafts in <details> with a mark-outreach form, and recent events", () => {
    const p = prospectRow({ name: 'Acme Web' });
    const drafts = new Map([[p.id, [draft(p.id, 'cold', 'Quick question', 'Hi <b>there</b>\n[Your name]'), draft(p.id, 'followup1', 'Following up', 'Again')]]]);
    const events: OutreachEventRow[] = [{ id: 'e1', prospectId: p.id, type: 'sent', note: HOSTILE, at: NOW, createdAt: NOW }];
    const { getByTestId } = render(
      <ValidateTab view={caseViewFixture()} validate={validateViewFixture({ prospects: { rows: [p], total: 1 }, drafts, events })} page={1} />,
    );
    const item = getByTestId('prospect-drafts');
    expect(item.tagName).toBe('DETAILS');
    expect(item.querySelector('summary')?.textContent).toContain('Acme Web');
    expect(item.textContent).toContain('Quick question');
    expect([...item.querySelectorAll('p.pre')].map((b) => b.textContent)).toContain('Hi <b>there</b>\n[Your name]');
    expect(item.querySelector('b')).toBeNull();

    const form = within(item).getByTestId('mark-outreach');
    expect(form.querySelector('input[name="prospectId"]')?.getAttribute('value')).toBe(p.id);
    expect(form.querySelector('input[name="slug"]')?.getAttribute('value')).toBe('lead-flow-verification');
    const options = [...form.querySelectorAll('select[name="type"] option')];
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note']);
    expect(options.at(-1)!.textContent).toBe('Interview note');
    expect(form.querySelector('input[name="note"]')?.getAttribute('maxlength')).toBe('500');

    const ev = getByTestId('events');
    expect(ev.textContent).toContain('Acme Web');
    expect(ev.textContent).toContain(HOSTILE);
    expect(ev.querySelector('img, script')).toBeNull();
  });

  it('renders hostile pack documents, checklist, draft subjects and bodies inertly', () => {
    const hostilize = <T,>(v: T): T => {
      if (typeof v === 'string') return `${HOSTILE}${v}` as T;
      if (Array.isArray(v)) return v.map(hostilize) as T;
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'metricKey' ? x : hostilize(x)])) as T;
      return v;
    };
    const sections = { ...hostilize(packFixture()), reviewNotes: [HOSTILE] };
    const p = prospectRow({ name: HOSTILE, location: HOSTILE, email: HOSTILE, fitReason: HOSTILE });
    const drafts = new Map([[p.id, [draft(p.id, 'cold', HOSTILE, HOSTILE), draft(p.id, 'followup2', `${HOSTILE}2`, `${HOSTILE}\n${HOSTILE}`)]]]);
    const validate = validateViewFixture({ prospects: { rows: [p], total: 1 }, drafts });
    validate.pack!.sections = sections;
    validate.pack!.model = HOSTILE;
    validate.checklist = [{ id: 'x', description: HOSTILE, metricKey: 'emails_sent', value: 0, threshold: 1, state: 'pending' }];
    const { container, getByTestId } = render(<ValidateTab view={caseViewFixture()} validate={validate} page={1} />);

    expect(container.textContent).not.toContain('The pack documents could not be read.');
    expect(container.textContent).toContain(`${HOSTILE}A lead-flow checker for agencies`);
    expect(container.textContent).toContain(`${HOSTILE}Question 8?`);
    expect(getByTestId('prospect-drafts').querySelector('h4')!.textContent).toBe(`Cold email: ${HOSTILE}`);
    expect(container.querySelector('img, script, iframe, style, object, embed')).toBeNull();
    for (const el of container.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
    }
  });

  it('paginates prospects 100 per page with links that keep the tab', () => {
    const { getByTestId } = render(
      <ValidateTab view={caseViewFixture()} validate={validateViewFixture({ prospects: { rows: [prospectRow()], total: 250 } })} page={2} />,
    );
    const pager = getByTestId('prospects-pager');
    expect(pager.textContent).toContain('Page 2 of 3');
    expect([...pager.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/cases/lead-flow-verification?tab=validate',
      '/cases/lead-flow-verification?tab=validate&page=3',
    ]);
  });
});
