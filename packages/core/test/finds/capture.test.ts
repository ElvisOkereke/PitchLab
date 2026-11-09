import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkCaptureUrl, makeReadPage, openCapture, type CaptureModule } from '../../src/finds/capture';
import { testDb } from '../helpers/db';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

describe('checkCaptureUrl', () => {
  it('allows a public http(s) host', async () => {
    expect(await checkCaptureUrl('https://www.instagram.com/reel/x', publicDns)).toBe(true);
  });

  it('refuses private, loopback and link-local answers, local names, never-fetch hosts and odd schemes', async () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1']) {
      expect(await checkCaptureUrl('https://evil.example.com/', async () => [{ address, family: address.includes(':') ? 6 : 4 }]), address).toBe(false);
    }
    // One bad answer among good ones is enough to refuse.
    expect(await checkCaptureUrl('https://mixed.example.com/', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).toBe(false);
    const lookup = vi.fn(publicDns);
    for (const u of ['http://localhost/', 'https://printer.local/', 'https://gamersgetaway.ca/x', 'https://shop.gamersgetaway.ca/', 'file:///c:/x', 'https://u:p@example.com/', 'http://10.0.0.1/', 'not a url']) {
      expect(await checkCaptureUrl(u, lookup), u).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(await checkCaptureUrl('https://nx.example.com/', async () => { throw new Error('ENOTFOUND'); })).toBe(false);
    expect(await checkCaptureUrl('https://empty.example.com/', async () => [])).toBe(false);
  });
});

describe('makeReadPage', () => {
  it('reads the page through collectPage (guarded fetch) and returns its title and text', async () => {
    const db = await testDb();
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, finalUrl: 'https://blog.example.com/p', title: 'A post', text: 'Body text '.repeat(100) }));
    const read = makeReadPage({ db, fetchPage, robotsAllows: async () => true, log: () => {} });
    const r = await read('https://blog.example.com/p');
    expect(r).toMatchObject({ caption: 'A post' });
    expect(r!.pageText).toContain('Body text');
    expect(fetchPage).toHaveBeenCalledWith('https://blog.example.com/p', expect.objectContaining({ blockHosts: expect.any(Array) }));
  });

  it('returns null when the page cannot be read', async () => {
    const db = await testDb();
    const read = makeReadPage({ db, fetchPage: async () => ({ ok: false, status: 403, finalUrl: '', title: '', text: '', reason: 'http_error' }), robotsAllows: async () => true, log: () => {} });
    expect(await read('https://blog.example.com/p')).toBeNull();
    const noRobots = makeReadPage({ db, fetchPage: async () => { throw new Error('should not fetch'); }, robotsAllows: async () => false, log: () => {} });
    expect(await noRobots('https://blog.example.com/p')).toBeNull();
  });
});

describe('openCapture', () => {
  it('starts the guarded proxy and passes it, the url check and the page reader to captureLink, with the standard folders', async () => {
    const db = await testDb();
    const captureLink = vi.fn(async () => ({ ok: false as const, platform: 'other' as const, error: 'x' }));
    const mod = { captureLink, scrubHandles: (t: string) => t, toolPaths: (d: string) => ({ ytdlp: join(d, 'yt-dlp.exe'), ffmpeg: join(d, 'ffmpeg.exe') }) } as unknown as CaptureModule;
    const close = vi.fn(async () => {});
    const startProxy = vi.fn(async () => ({ port: 4567, address: '127.0.0.1', close }));
    const c = await openCapture({ db, log: () => {}, root: 'R:/repo', importer: async () => mod, startProxy, exists: () => true });
    expect(c).not.toBeNull();
    expect(c!.toolsPresent).toBe(true);
    await c!.capture('https://www.tiktok.com/@a/video/1');
    const opts = (captureLink.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(opts).toMatchObject({
      toolsDir: join('R:/repo', '.tools'), profileDir: join('R:/repo', '.data', 'capture-profile'), tmpDir: join('R:/repo', '.data', 'capture-tmp'), proxyUrl: 'http://127.0.0.1:4567',
    });
    expect(typeof opts.checkUrl).toBe('function');
    expect(typeof opts.readPage).toBe('function');
    // The proxy refuses never-fetch hosts.
    const proxyOpts = (startProxy.mock.calls[0] as unknown as [{ isBlockedHost: (h: string) => boolean }])[0];
    expect(proxyOpts.isBlockedHost('gamersgetaway.ca')).toBe(true);
    expect(proxyOpts.isBlockedHost('www.instagram.com')).toBe(false);
    await c!.close();
    expect(close).toHaveBeenCalled();
  });

  it('returns null when the capture package cannot load or the proxy cannot start', async () => {
    const db = await testDb();
    expect(await openCapture({ db, log: () => {}, root: 'R:/repo', importer: async () => { throw new Error('missing'); } })).toBeNull();
    const mod = { captureLink: vi.fn(), scrubHandles: (t: string) => t, toolPaths: () => ({ ytdlp: 'a', ffmpeg: 'b' }) } as unknown as CaptureModule;
    expect(await openCapture({ db, log: () => {}, root: 'R:/repo', importer: async () => mod, startProxy: async () => { throw new Error('no port'); } })).toBeNull();
  });
});
