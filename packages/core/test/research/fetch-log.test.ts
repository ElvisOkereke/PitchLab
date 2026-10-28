import { describe, expect, it, vi } from 'vitest';
import { pageFetches } from '../../src/db/schema';
import { classifyFetch, fetchStats, recordFetch } from '../../src/research/fetch-log';
import type { PageResult } from '../../src/tools/fetch-page';
import { testDb } from '../helpers/db';

const fail = (reason: PageResult['reason'], status = 0): PageResult => ({ ok: false, status, finalUrl: 'x', title: '', text: '', reason });

describe('classifyFetch', () => {
  it('maps http statuses', () => {
    expect(classifyFetch(fail('http_error', 403))).toBe('http_403');
    expect(classifyFetch(fail('http_error', 404))).toBe('http_404');
    expect(classifyFetch(fail('http_error', 410))).toBe('http_410');
    expect(classifyFetch(fail('http_error', 429))).toBe('http_4xx');
    expect(classifyFetch(fail('http_error', 500))).toBe('http_5xx');
    expect(classifyFetch(fail('http_error', 503))).toBe('http_5xx');
  });
  it('maps the other failures and success', () => {
    expect(classifyFetch(fail('timeout'))).toBe('timeout');
    expect(classifyFetch(fail('too_large'))).toBe('too_large');
    expect(classifyFetch(fail('not_html'))).toBe('not_html');
    expect(classifyFetch(fail('network'))).toBe('network');
    expect(classifyFetch(fail('blocked_scheme'))).toBe('blocked_host');
    expect(classifyFetch(fail('blocked_host'))).toBe('blocked_host');
    expect(classifyFetch({ ok: true, status: 200, finalUrl: 'x', title: '', text: 'hi' })).toBe('ok');
    expect(classifyFetch({ robots: false })).toBe('blocked_robots');
    expect(classifyFetch({ thin: true })).toBe('thin_text');
  });
});

describe('recordFetch', () => {
  it('stores the registrable domain only', async () => {
    const db = await testDb();
    await recordFetch(db, { url: 'https://www.news.example.co.uk/a/b?token=secret', outcome: 'http_403', via: 'direct', status: 403 });
    const rows = await db.select().from(pageFetches);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ urlDomain: 'example.co.uk', outcome: 'http_403', via: 'direct', status: 403 });
    expect(JSON.stringify(rows[0])).not.toContain('secret');
  });
  it('never throws', async () => {
    const db = await testDb();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordFetch(db, { url: 'not a url', outcome: 'network', via: 'direct' })).resolves.toBeUndefined();
    const broken = { insert: () => { throw new Error('boom'); } } as never;
    await expect(recordFetch(broken, { url: 'https://a.example/', outcome: 'ok', via: 'direct' })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('fetchStats', () => {
  it('is empty-safe', async () => {
    const s = await fetchStats(await testDb(), {});
    expect(s).toMatchObject({ total: 0, ok: 0, okRate: null, topFailing: [] });
    expect(s.byVia).toEqual({ direct: { total: 0, ok: 0 }, archive: { total: 0, ok: 0 }, browser: { total: 0, ok: 0 } });
  });
  it('computes rates, via split, top failing, window and bound', async () => {
    const db = await testDb();
    const rec = (url: string, outcome: Parameters<typeof recordFetch>[1]['outcome'], via: 'direct' | 'archive' | 'browser' = 'direct') =>
      recordFetch(db, { url, outcome, via });
    await rec('https://good.example/1', 'ok'); await rec('https://good.example/2', 'ok'); await rec('https://good.example/3', 'ok', 'archive');
    await rec('https://bad.example/1', 'http_403'); await rec('https://bad.example/2', 'http_403'); await rec('https://bad.example/3', 'timeout');
    await rec('https://bad.example/4', 'ok', 'browser');
    for (let i = 0; i < 12; i++) await rec(`https://f${i}.example/`, 'network');
    await db.insert(pageFetches).values({ urlDomain: 'old.example', outcome: 'network', via: 'direct', at: new Date(Date.now() - 40 * 86_400_000) });
    const s = await fetchStats(db, { days: 30 });
    expect(s.total).toBe(7 + 12);
    expect(s.ok).toBe(4);
    expect(s.okRate).toBeCloseTo(4 / 19);
    expect(s.byVia.archive).toEqual({ total: 1, ok: 1 });
    expect(s.byVia.browser).toEqual({ total: 1, ok: 1 });
    expect(s.byVia.direct.total).toBe(17);
    expect(s.byOutcome.http_403).toBe(2);
    expect(s.topFailing).toHaveLength(10);
    expect(s.topFailing[0]).toEqual({ domain: 'bad.example', failures: 3, topOutcome: 'http_403' });
    expect((await fetchStats(db, { days: 60 })).total).toBe(20);
  });
});
