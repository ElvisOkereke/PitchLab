import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { captureLink, resetCapturePacing, TOOL_TIMEOUT_MS, type CaptureOptions } from '../src/capture';
import { fakeSpawn, type Behaviour } from './fake-spawn';

let root: string;
let toolsDir: string;
let profileDir: string;
let tmpDir: string;

beforeEach(() => {
  resetCapturePacing();
  root = mkdtempSync(join(tmpdir(), 'bcg-capture-test-'));
  toolsDir = join(root, '.tools');
  profileDir = join(root, '.data', 'capture', 'browser', 'Default');
  tmpDir = join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ytdlp = () => join(toolsDir, 'yt-dlp.exe');
const ffmpeg = () => join(toolsDir, 'ffmpeg.exe');
const whisper = () => join(toolsDir, 'whisper', 'whisper-cli.exe');
const model = () => join(toolsDir, 'models', 'ggml-base.bin');

const INFO = {
  title: 'Video by someone',
  description: 'How I make $10k a month selling planners',
  uploader: 'someone',
  view_count: 120000,
  like_count: 5400,
  comment_count: 310,
  duration: 31.5,
  upload_date: '20261101',
};

function valueAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

interface Overrides {
  meta?: Behaviour;
  audio?: Behaviour;
  video?: Behaviour;
  wav?: Behaviour;
  whisper?: Behaviour;
  frames?: Behaviour;
  frameCount?: number;
}

/** Behaves like the real tools: writes the files each would write into the work folder. */
function tools(o: Overrides = {}) {
  return fakeSpawn((command, args) => {
    if (command === ytdlp() && args.includes('--dump-json')) return o.meta ?? { stdout: JSON.stringify(INFO) };
    if (command === ytdlp()) {
      const out = valueAfter(args, '-o');
      const isAudio = valueAfter(args, '-f') === 'bestaudio/best';
      const b = (isAudio ? o.audio : o.video) ?? {};
      return { effect: () => writeFileSync(out.replace('%(ext)s', isAudio ? 'm4a' : 'mp4'), 'media'), ...b };
    }
    if (command === ffmpeg() && args.includes('-ar')) {
      return { effect: (a) => writeFileSync(a[a.length - 1], 'wav'), ...o.wav };
    }
    if (command === ffmpeg()) {
      return {
        effect: (a) => {
          const pattern = a[a.length - 1];
          for (let i = 1; i <= (o.frameCount ?? 3); i++) writeFileSync(pattern.replace('%03d', String(i).padStart(3, '0')), 'png');
        },
        ...o.frames,
      };
    }
    if (command === whisper()) {
      return {
        effect: (a) =>
          writeFileSync(
            `${valueAfter(a, '-of')}.json`,
            JSON.stringify({ result: { language: 'en' }, transcription: [{ text: ' Hello there.' }, { text: ' Buy my planner.' }] }),
          ),
        ...o.whisper,
      };
    }
    throw new Error(`unexpected command ${command}`);
  });
}

function opts(extra: Partial<CaptureOptions> = {}): CaptureOptions {
  return {
    toolsDir,
    profileDir,
    tmpDir,
    ocr: async (paths) => paths.map(() => 'SAVE THIS\nsave this\n\nLink in bio'),
    sleep: async () => {},
    ...extra,
  };
}

describe('captureLink', () => {
  it('runs each tool with the exact argument arrays, no shell, and returns text and stats', async () => {
    const { spawn, calls } = tools();
    const url = 'https://www.youtube.com/shorts/abc123';
    const res = await captureLink(url, opts({ spawn }));

    expect(calls.map((c) => basename(c.command))).toEqual(['yt-dlp.exe', 'yt-dlp.exe', 'yt-dlp.exe', 'ffmpeg.exe', 'whisper-cli.exe', 'ffmpeg.exe']);
    for (const c of calls) expect(c.options).toMatchObject({ shell: false, windowsHide: true });

    const work = dirname(valueAfter(calls[1].args, '-o'));
    expect(dirname(work)).toBe(tmpDir);
    const yt = ['--ignore-config', '--no-plugin-dirs'];
    expect(calls[0].args).toEqual([...yt, '--dump-json', '--no-playlist', '--no-warnings', '--no-progress', '--', url]);
    const dl = [...yt, '--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', '200M', '--ffmpeg-location', toolsDir];
    expect(calls[1].args).toEqual([...dl, '-f', 'bestaudio/best', '-o', join(work, 'audio.%(ext)s'), '--', url]);
    expect(calls[2].args).toEqual([...dl, '-f', 'bv*[height<=480]/b[height<=480]/worst', '-o', join(work, 'video.%(ext)s'), '--', url]);
    const ff = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe'];
    expect(calls[3].args).toEqual([...ff, '-i', join(work, 'audio.m4a'), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(work, 'audio.wav')]);
    expect(calls[4].args).toEqual(['-m', model(), '-f', join(work, 'audio.wav'), '-l', 'auto', '-oj', '-of', join(work, 'transcript'), '-np']);
    expect(calls[5].args).toEqual([...ff, '-i', join(work, 'video.mp4'), '-vf', 'fps=1/2', '-frames:v', '20', join(work, 'frame-%03d.png')]);

    expect(res).toEqual({
      ok: true,
      platform: 'youtube',
      title: 'YouTube video',
      caption: 'How I make $10k a month selling planners',
      transcript: 'Hello there. Buy my planner.',
      screenText: 'SAVE THIS\nLink in bio',
      stats: { views: 120000, likes: 5400, comments: 310, durationSec: 31.5, uploadedAt: '2026-11-01' },
      language: 'en',
      warnings: [],
    });
    expect(existsSync(work)).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/someone/i);
  });

  it('passes the capture browser cookies (its Default profile) only for Instagram, Facebook and TikTok, and only to yt-dlp', async () => {
    const cases: [string, boolean][] = [
      ['https://www.instagram.com/reel/abc/', true],
      ['https://www.facebook.com/reel/123', true],
      ['https://www.tiktok.com/@a/video/1', true],
      ['https://www.youtube.com/shorts/x', false],
      ['https://www.threads.net/@a/post/1', false],
    ];
    for (const [url, cookies] of cases) {
      resetCapturePacing();
      const { spawn, calls } = tools();
      const res = await captureLink(url, opts({ spawn }));
      expect(res.ok).toBe(true);
      for (const c of calls) {
        const has = c.args.includes('--cookies-from-browser');
        expect(has).toBe(cookies && c.command === ytdlp());
        if (has) {
          // yt-dlp takes the profile path's parent as the browser's user data dir (where Local State lives).
          expect(valueAfter(c.args, '--cookies-from-browser')).toBe(`chromium:${join(root, '.data', 'capture', 'browser', 'Default')}`);
          expect(c.args.slice(-2)).toEqual(['--', url]);
        }
      }
    }
  });

  it('defaults to a 3-minute timeout per tool', () => {
    expect(TOOL_TIMEOUT_MS).toBe(180_000);
  });

  it('kills a hung yt-dlp and reports a timeout', async () => {
    const { spawn, calls } = tools({ meta: { hang: true } });
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, timeoutMs: 30 }));
    expect(calls[0].killed).toBe(true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/timed out/i);
  });

  it('kills a hung whisper, keeps going, and still returns the rest', async () => {
    const { spawn, calls } = tools({ whisper: { hang: true } });
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, timeoutMs: 30 }));
    expect(calls.find((c) => c.command === whisper())!.killed).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.transcript).toBe('');
      expect(res.screenText).toBe('SAVE THIS\nLink in bio');
      expect(res.warnings.join(' ')).toMatch(/timed out/i);
    }
  });

  it('turns a yt-dlp failure into ok:false with the readPage fallback', async () => {
    const { spawn } = tools({ meta: { code: 1, stderr: 'ERROR: [Instagram] abc: Requested content is not available' } });
    const readPage = vi.fn(async () => ({ caption: 'A caption from og:description', pageText: 'Visible page text' }));
    const url = 'https://www.instagram.com/p/abc/';
    const res = await captureLink(url, opts({ spawn, readPage }));
    expect(readPage).toHaveBeenCalledWith(url);
    expect(res).toEqual({
      ok: false,
      platform: 'instagram',
      error: expect.stringMatching(/not available/),
      fallback: { caption: 'A caption from og:description', pageText: 'Visible page text' },
    });
  });

  it('has no fallback without readPage, or when readPage throws', async () => {
    const meta = { code: 1, stderr: 'ERROR: Video unavailable' };
    const a = await captureLink('https://www.youtube.com/watch?v=gone', opts({ spawn: tools({ meta }).spawn }));
    expect(a).toEqual({ ok: false, platform: 'youtube', error: expect.stringMatching(/Video unavailable/) });
    resetCapturePacing();
    const b = await captureLink(
      'https://www.youtube.com/watch?v=gone',
      opts({ spawn: tools({ meta }).spawn, readPage: async () => Promise.reject(new Error('blocked')) }),
    );
    expect(b.ok).toBe(false);
    expect('fallback' in b && b.fallback).toBeFalsy();
  });

  it('says how to install the tools when yt-dlp is missing', async () => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools({ meta: { error } }).spawn }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/npm run capture:setup/);
  });

  it('sanitises tool stderr in errors, warnings and logs', async () => {
    const leak = `ERROR: failed to load cookies from ${profileDir}\\Default\\Network\\Cookies sessionid=99887766554433%3Aqwerty; Authorization: Bearer abcdef0123456789abcdef0123456789`;
    const log = vi.fn();
    const res = await captureLink('https://www.instagram.com/reel/abc/', opts({ spawn: tools({ meta: { code: 1, stderr: leak } }).spawn, log }));
    expect(res.ok).toBe(false);
    const all = [!res.ok ? res.error : '', ...log.mock.calls.map((c) => String(c[0]))].join('\n');
    for (const s of [profileDir, 'browser', 'Default', '.data', '99887766554433', 'qwerty', 'abcdef0123456789', root]) expect(all).not.toContain(s);

    resetCapturePacing();
    const res2 = await captureLink(
      'https://www.youtube.com/shorts/x',
      opts({ spawn: tools({ wav: { code: 1, stderr: `Error opening ${tmpDir}\\capture-x\\audio.m4a token=abc123secret` } }).spawn }),
    );
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      const w = res2.warnings.join('\n');
      expect(w).not.toContain(tmpDir);
      expect(w).not.toContain('abc123secret');
    }
  });

  it('removes the work folder on success, on failure and when OCR throws', async () => {
    await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools().spawn }));
    resetCapturePacing();
    await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools({ meta: { code: 1, stderr: 'ERROR: nope' } }).spawn }));
    resetCapturePacing();
    const res = await captureLink(
      'https://www.youtube.com/shorts/x',
      opts({ spawn: tools().spawn, ocr: async () => Promise.reject(new Error('ocr crashed')) }),
    );
    expect(res.ok).toBe(true);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('OCRs at most 20 frames, in order, and de-duplicates lines', async () => {
    const ocr = vi.fn(async (paths: string[]) => paths.map((p, i) => (i % 2 ? `Line A\n  line   a \nframe ${basename(p)}` : 'Line A\nPrice: $29')));
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools({ frameCount: 30 }).spawn, ocr }));
    const paths = ocr.mock.calls[0][0];
    expect(paths).toHaveLength(20);
    expect(paths.map((p) => basename(p))).toEqual(Array.from({ length: 20 }, (_, i) => `frame-${String(i + 1).padStart(3, '0')}.png`));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const lines = res.screenText.split('\n');
      expect(lines.filter((l) => /^line a$/i.test(l.trim().replace(/\s+/g, ' ')))).toHaveLength(1);
      expect(lines.filter((l) => l === 'Price: $29')).toHaveLength(1);
      expect(lines[0]).toBe('Line A');
    }
  });

  it('refuses non-http(s) URLs without spawning anything', async () => {
    const { spawn, calls } = tools();
    const res = await captureLink('file:///C:/Windows/win.ini', opts({ spawn }));
    expect(res).toEqual({ ok: false, platform: 'other', error: expect.stringMatching(/http/) });
    expect(calls).toHaveLength(0);
  });

  it('waits at least 20 seconds between Instagram or TikTok captures, but not for other platforms', async () => {
    let clock = 1_000_000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const now = () => clock;
    await captureLink('https://www.tiktok.com/@a/video/1', opts({ spawn: tools().spawn, now, sleep }));
    expect(sleep).not.toHaveBeenCalled();
    clock += 5_000;
    await captureLink('https://www.instagram.com/reel/b/', opts({ spawn: tools().spawn, now, sleep }));
    expect(sleep).toHaveBeenCalledWith(15_000);
    sleep.mockClear();
    await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools().spawn, now, sleep }));
    expect(sleep).not.toHaveBeenCalled();
  });

  it('runs one capture at a time', async () => {
    const order: string[] = [];
    const { spawn } = tools({
      meta: { stdout: JSON.stringify(INFO), effect: () => order.push('meta') },
      frames: { effect: () => order.push('done') },
    });
    await Promise.all([
      captureLink('https://www.youtube.com/shorts/1', opts({ spawn })),
      captureLink('https://www.youtube.com/shorts/2', opts({ spawn })),
    ]);
    expect(order).toEqual(['meta', 'done', 'meta', 'done']);
  });

  it('replaces creator handles with "the creator" everywhere and drops "Video by" boilerplate', async () => {
    const info = {
      ...INFO,
      title: 'Reel by Plan.Queen',
      description: 'Follow @plan.queen for more! PLAN.QUEEN ships worldwide. Collab with planqueen_shop and Jane Doe',
      uploader: 'Plan.Queen',
      uploader_id: 'planqueen_shop',
      channel: 'Jane Doe',
      creator: 'JD',
    };
    const { spawn } = tools({
      meta: { stdout: JSON.stringify(info) },
      wav: { code: 1, stderr: 'ERROR: could not open audio for planqueen_shop' },
    });
    const ocr = async (paths: string[]) => paths.map(() => '@plan.queen\nShop now');
    const res = await captureLink('https://www.instagram.com/reel/abc/', opts({ spawn, ocr }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.title).toBe('Instagram video');
      expect(res.caption).toBe('Follow the creator for more! the creator ships worldwide. Collab with the creator and the creator');
      expect(res.screenText).toBe('the creator\nShop now');
      expect(res.warnings.join(' ')).toContain('the creator');
    }
    expect(JSON.stringify(res)).not.toMatch(/plan\.?queen|jane doe/i);
  });

  it('keeps a real title after "Post by <handle>:" boilerplate, and scrubs a TikTok @handle from the URL out of errors', async () => {
    const r1 = await captureLink(
      'https://www.youtube.com/shorts/x',
      opts({ spawn: tools({ meta: { stdout: JSON.stringify({ ...INFO, title: 'Post by someone: 5 planner hacks' }) } }).spawn }),
    );
    expect(r1.ok && r1.title).toBe('5 planner hacks');
    resetCapturePacing();
    const r2 = await captureLink(
      'https://www.tiktok.com/@shopgirl99/video/1',
      opts({ spawn: tools({ meta: { code: 1, stderr: 'ERROR: [TikTok] shopgirl99: account is private (@shopgirl99)' } }).spawn }),
    );
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toMatch(/shopgirl99/i);
  });

  it('routes every yt-dlp call through proxyUrl, and only yt-dlp', async () => {
    const { spawn, calls } = tools();
    await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, proxyUrl: 'http://127.0.0.1:41234' }));
    const yts = calls.filter((c) => c.command === ytdlp());
    expect(yts).toHaveLength(3);
    for (const c of yts) {
      expect(c.args.slice(0, 4)).toEqual(['--ignore-config', '--no-plugin-dirs', '--proxy', 'http://127.0.0.1:41234']);
    }
    for (const c of calls.filter((c) => c.command !== ytdlp())) expect(c.args).not.toContain('--proxy');
  });

  it('refuses when checkUrl does not answer within the timeout', async () => {
    const { spawn, calls } = tools();
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, timeoutMs: 20, checkUrl: () => new Promise<boolean>(() => {}) }));
    expect(res).toEqual({ ok: false, platform: 'youtube', error: expect.stringMatching(/not allowed/i) });
    expect(calls).toHaveLength(0);
  });

  it('scrubs an Instagram profile name from the URL path out of errors raised before metadata', async () => {
    const res = await captureLink(
      'https://www.instagram.com/plannerqueen77/reel/ABC123/',
      opts({ spawn: tools({ meta: { code: 1, stderr: 'ERROR: [Instagram] https://www.instagram.com/plannerqueen77/reel/ABC123/: login required for plannerqueen77' } }).spawn }),
    );
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/plannerqueen77/i);
    resetCapturePacing();
    const reel = await captureLink(
      'https://www.instagram.com/reel/ABC123/',
      opts({ spawn: tools({ meta: { code: 1, stderr: 'ERROR: [Instagram] reel ABC123: login required' } }).spawn }),
    );
    expect(!reel.ok && reel.error).toMatch(/reel ABC123/);
  });

  it('refuses before spawning when checkUrl says no', async () => {
    const { spawn, calls } = tools();
    const checkUrl = vi.fn(async () => false);
    const res = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, checkUrl }));
    expect(checkUrl).toHaveBeenCalledWith('https://www.youtube.com/shorts/x');
    expect(res).toEqual({ ok: false, platform: 'youtube', error: expect.stringMatching(/not allowed/i) });
    expect(calls).toHaveLength(0);
    resetCapturePacing();
    const ok = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn, checkUrl: async () => true }));
    expect(ok.ok).toBe(true);
  });

  it.each([
    'http://127.0.0.1/x',
    'http://10.0.0.5/v',
    'http://[::1]/v',
    'http://2130706433/v',
    'http://localhost:3000/v',
    'http://foo.localhost/v',
    'http://printer.local/v',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://intranet/v',
    'http://127.1/v',
    'http://0x7f000001/v',
    'http://localhost./v',
    'http://localhost../v',
    'http://printer.local../v',
  ])('refuses the private or local host %s without spawning or reading the page', async (url) => {
    const { spawn, calls } = tools();
    const readPage = vi.fn(async () => ({ pageText: 'secret' }));
    const res = await captureLink(url, opts({ spawn, readPage }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/not allowed/i);
      expect(res.fallback).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
    expect(readPage).not.toHaveBeenCalled();
  });

  it('does not run yt-dlp for an unknown site; it goes straight to the page reader', async () => {
    const { spawn, calls } = tools();
    const readPage = vi.fn(async () => ({ caption: 'og description', pageText: 'Article text' }));
    const res = await captureLink('https://example.com/article', opts({ spawn, readPage }));
    expect(calls).toHaveLength(0);
    expect(readPage).toHaveBeenCalledWith('https://example.com/article');
    expect(res).toEqual({ ok: false, platform: 'other', error: expect.any(String), fallback: { caption: 'og description', pageText: 'Article text' } });
    resetCapturePacing();
    const bare = await captureLink('https://example.com/article', opts({ spawn }));
    expect(bare).toEqual({ ok: false, platform: 'other', error: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it('a hanging readPage or OCR times out instead of blocking the queue', async () => {
    const never = () => new Promise<never>(() => {});
    const r1 = await captureLink('https://example.com/a', opts({ spawn: tools().spawn, readPage: never, timeoutMs: 30 }));
    expect(r1).toEqual({ ok: false, platform: 'other', error: expect.any(String) });
    const r2 = await captureLink('https://www.youtube.com/shorts/x', opts({ spawn: tools().spawn, ocr: never, timeoutMs: 30 }));
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.screenText).toBe('');
      expect(r2.warnings.join(' ')).toMatch(/timed out/i);
    }
  });
});
