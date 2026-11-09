import type { FindRow } from '@bcg/core/finds/store';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/finds', () => ({
  addFindsAction: vi.fn(async () => ({})),
  retryFindAction: vi.fn(async () => {}),
  deleteFindAction: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { FindsView } = await import('@/components/finds-view');

afterEach(cleanup);

const NOW = new Date('2026-11-09T15:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

function find(o: Partial<FindRow> = {}): FindRow {
  return {
    id: ID, url: 'https://www.tiktok.com/@a/video/1', platform: 'tiktok', title: 'Plumber invoice hack', note: 'try this for HVAC', source: 'telegram',
    status: 'done', caption: null, transcript: null, screenText: null, stats: { views: 12345, likes: 678, durationSec: 75 }, error: null, warnings: [],
    knowledgeItemId: ITEM, startedAt: null, createdAt: new Date('2026-11-09T14:00:00Z'), capturedAt: new Date('2026-11-09T14:05:00Z'), ...o,
  };
}
const view = (rows: FindRow[], telegramConnected = true) => render(<FindsView finds={rows} telegramConnected={telegramConnected} now={NOW} />);

describe('FindsView', () => {
  it('explains what Finds does and shows the paste box', () => {
    view([]);
    expect(screen.getByText(/Share links to your Telegram bot or paste them here\. PitchLab downloads each one, transcribes it, reads on-screen text and adds it to your library\./)).toBeTruthy();
    expect(screen.getByLabelText(/links/i)).toBeTruthy();
    expect(screen.getByText(/No finds yet/)).toBeTruthy();
  });

  it('shows the Telegram hint only when Telegram is not connected', () => {
    view([], false);
    expect(screen.getByText(/OWNER-TODO/)).toBeTruthy();
    cleanup();
    view([], true);
    expect(screen.queryByText(/OWNER-TODO/)).toBeNull();
  });

  it('a done find shows platform, title, note, stats, time and a link to its library entry, with Delete but no Retry', () => {
    view([find()]);
    const row = screen.getByTestId(`find-${ID}`);
    const t = row.textContent ?? '';
    expect(t).toContain('done');
    expect(t).toContain('tiktok');
    expect(t).toContain('Plumber invoice hack');
    expect(t).toContain('try this for HVAC');
    expect(t).toContain('12,345 views');
    expect(t).toContain('678 likes');
    expect(t).toContain('1:15');
    expect(t).toContain('2026-11-09 09:05');
    expect(within(row).getByRole('link', { name: /library entry/i }).getAttribute('href')).toBe(`/library?item=${ITEM}`);
    expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('a failed find shows its error and warnings, with Retry and Delete', () => {
    view([find({ status: 'failed', error: 'Could not read that link.', warnings: ['no audio track'], knowledgeItemId: null, title: null, stats: null, capturedAt: null })]);
    const row = screen.getByTestId(`find-${ID}`);
    expect(row.textContent).toContain('Could not read that link.');
    expect(row.textContent).toContain('no audio track');
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(row).queryByRole('link', { name: /library entry/i })).toBeNull();
  });

  it('a capturing find has no Delete', () => {
    view([find({ status: 'capturing', knowledgeItemId: null })]);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('renders hostile text as text (R13)', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { container } = view([find({ title: evil, note: evil, error: evil, status: 'failed', warnings: [evil], url: 'https://example.com/?q=<b>x</b>' })]);
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container.textContent).toContain(evil);
  });

  it('shows the link as text only, so a hostile address is never a clickable link', () => {
    const { container } = view([find({ url: 'javascript:alert(1)' })]);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('keeps the run-from-finds button out until core supports the finds seed', () => {
    view([find()]);
    expect(screen.queryByRole('button', { name: /start a run from these finds/i })).toBeNull();
  });
});
