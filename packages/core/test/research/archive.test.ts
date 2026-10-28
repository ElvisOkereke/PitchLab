import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveSnapshot, fetchArchived } from '../../src/research/archive';
import { resetThrottle, SourceError, USER_AGENT } from '../../src/research/http';
import type { PageResult } from '../../src/tools/fetch-page';

const NOW = new Date('2026-10-28T00:00:00Z');
const avail = (timestamp: string, available = true, url = `http://web.archive.org/web/${timestamp}/https://x.example/p`) => ({
  archived_snapshots: available ? { closest: { available: true, url, timestamp, status: '200' } } : {},
});
const sleep = async () => {};

beforeEach(() => resetThrottle());

describe('archiveSnapshot', () => {
  it('returns the raw id_ snapshot form and its timestamp', async () => {
    const fetchJson = vi.fn(async () => avail('20260101120000'));
    const s = await archiveSnapshot('https://x.example/p', { fetchJson, now: () => NOW, http: { sleep } });
    expect(s).toEqual({ snapshotUrl: 'https://web.archive.org/web/20260101120000id_/https://x.example/p', timestamp: new Date('2026-01-01T12:00:00Z') });
    expect(fetchJson).toHaveBeenCalledWith(`https://archive.org/wayback/available?url=${encodeURIComponent('https://x.example/p')}`);
  });
  it('returns null when there is no snapshot', async () => {
    expect(await archiveSnapshot('https://x.example/p', { fetchJson: async () => avail('', false), now: () => NOW, http: { sleep } })).toBeNull();
  });
  it('returns null when the snapshot is older than three years', async () => {
    expect(await archiveSnapshot('https://x.example/p', { fetchJson: async () => avail('20230101000000'), now: () => NOW, http: { sleep } })).toBeNull();
  });
  it('ignores a snapshot that is not on web.archive.org', async () => {
    const fetchJson = async () => avail('20260101000000', true, 'https://evil.example/web/20260101000000/https://x.example/p');
    expect(await archiveSnapshot('https://x.example/p', { fetchJson, now: () => NOW, http: { sleep } })).toBeNull();
  });
  it('maps a 429 from the default transport to rate_limited', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof globalThis.fetch;
    const p = archiveSnapshot('https://x.example/p', { now: () => NOW, http: { fetch, sleep } });
    await expect(p).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(archiveSnapshot('https://x.example/p', { now: () => NOW, http: { fetch, sleep } })).rejects.toBeInstanceOf(SourceError);
  });
  it('waits one second between archive requests', async () => {
    const sleeps: number[] = [];
    let t = 1000;
    const http = { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
    const fetchJson = async () => avail('', false);
    await archiveSnapshot('https://x.example/a', { fetchJson, now: () => NOW, http });
    await archiveSnapshot('https://x.example/b', { fetchJson, now: () => NOW, http });
    expect(sleeps).toEqual([1000]);
  });
});

describe('archiveSnapshot policy', () => {
  const opts = (fetchJson: () => Promise<unknown>) => ({ fetchJson, now: () => NOW, http: { sleep } });
  it('requires status 200', async () => {
    const j = avail('20260101000000');
    (j.archived_snapshots as any).closest.status = '302';
    expect(await archiveSnapshot('https://x.example/p', opts(async () => j))).toBeNull();
  });
  it('refuses a snapshot of a different original', async () => {
    const j = avail('20260101000000', true, 'http://web.archive.org/web/20260101000000/https://other.example/p');
    expect(await archiveSnapshot('https://x.example/p', opts(async () => j))).toBeNull();
  });
  it('refuses a banned original even when it was requested', async () => {
    const j = avail('20260101000000', true, 'http://web.archive.org/web/20260101000000/https://www.reddit.com/r/x');
    expect(await archiveSnapshot('https://www.reddit.com/r/x', opts(async () => j))).toBeNull();
    const k = avail('20260101000000', true, 'http://web.archive.org/web/20260101000000/https://gamersgetaway.ca/p');
    expect(await archiveSnapshot('https://gamersgetaway.ca/p', opts(async () => k))).toBeNull();
  });
  it('matches the original after normalisation (host case, default port, trailing slash)', async () => {
    const j = avail('20260101000000', true, 'http://web.archive.org/web/20260101000000/https://X.example:443/p/');
    expect(await archiveSnapshot('https://x.example/p', opts(async () => j))).not.toBeNull();
  });
});

describe('fetchArchived', () => {
  const snap = { snapshotUrl: 'https://web.archive.org/web/20260101120000id_/https://x.example/p', timestamp: new Date('2026-01-01T12:00:00Z') };
  const ok = (finalUrl: string): PageResult => ({ ok: true, status: 200, finalUrl, title: 'T', text: 'archived text' });
  it('fetches the raw snapshot with the research user agent', async () => {
    const fetchPage = vi.fn(async (u: string) => ok(u));
    const r = await fetchArchived(snap, { fetchPage: fetchPage as never, http: { sleep } });
    expect(r.ok).toBe(true);
    expect(fetchPage).toHaveBeenCalledWith(snap.snapshotUrl, expect.objectContaining({ userAgent: USER_AGENT }));
  });
  it('refuses a redirect off web.archive.org', async () => {
    const fetchPage = vi.fn(async () => ok('https://other.example/page'));
    const r = await fetchArchived(snap, { fetchPage: fetchPage as never, http: { sleep } });
    expect(r).toMatchObject({ ok: false, reason: 'blocked_host', text: '' });
  });
  it('refuses a snapshot url that is not on web.archive.org without fetching', async () => {
    const fetchPage = vi.fn();
    const r = await fetchArchived({ ...snap, snapshotUrl: 'https://evil.example/x' }, { fetchPage: fetchPage as never, http: { sleep } });
    expect(r).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe('fetchArchived embedded original', () => {
  const snap = { snapshotUrl: 'https://web.archive.org/web/20260101120000id_/https://x.example/p', timestamp: new Date('2026-01-01T12:00:00Z') };
  const page = (finalUrl: string): PageResult => ({ ok: true, status: 200, finalUrl, title: 'T', text: 'archived text' });
  it('refuses an in-archive redirect to a different original', async () => {
    const r = await fetchArchived(snap, { fetchPage: (async () => page('https://web.archive.org/web/20260101120000id_/https://other.example/q')) as never, http: { sleep } });
    expect(r).toMatchObject({ ok: false, reason: 'blocked_host' });
  });
  it('refuses a banned original and passes allowHosts and blockHosts', async () => {
    const fetchPage = vi.fn();
    const r = await fetchArchived({ ...snap, snapshotUrl: 'https://web.archive.org/web/20260101120000id_/https://www.reddit.com/r/x' }, { fetchPage: fetchPage as never, http: { sleep } });
    expect(r).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(fetchPage).not.toHaveBeenCalled();
    const ok = vi.fn(async () => page(snap.snapshotUrl));
    await fetchArchived(snap, { fetchPage: ok as never, http: { sleep } });
    expect(ok).toHaveBeenCalledWith(snap.snapshotUrl, expect.objectContaining({ allowHosts: ['web.archive.org'], blockHosts: expect.arrayContaining(['reddit.com']) }));
  });
});
