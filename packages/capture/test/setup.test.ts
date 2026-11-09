import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTools, type ToolEntry } from '../scripts/setup';
import { TOOLS } from '../src/tools';

let toolsDir: string;
beforeEach(() => {
  toolsDir = join(mkdtempSync(join(tmpdir(), 'bcg-setup-test-')), '.tools');
});
afterEach(() => rmSync(join(toolsDir, '..'), { recursive: true, force: true }));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function mockFetch(bodies: Record<string, string>, status = 200) {
  return vi.fn(async (url: string | URL) => {
    const body = bodies[String(url)];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status });
  });
}

const fileEntry = (over: Partial<Pick<ToolEntry, 'version' | 'url' | 'sha256'>> = {}): ToolEntry => ({
  id: 'yt-dlp',
  version: '2026.10.26',
  url: 'https://example.test/yt-dlp.exe',
  sha256: sha('EXE-BYTES'),
  size: 9,
  kind: 'file',
  target: 'yt-dlp.exe',
  ...over,
});

describe('pinned tool table', () => {
  it('pins https URLs, the version in each URL and a SHA-256 for every tool', () => {
    expect(TOOLS.map((t) => t.id).sort()).toEqual(['ffmpeg', 'model', 'whisper', 'yt-dlp']);
    for (const t of TOOLS) {
      expect(t.url).toMatch(/^https:\/\//);
      expect(t.url).toContain(t.version);
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.size).toBeGreaterThan(1_000_000);
    }
  });
});

describe('installTools', () => {
  it('downloads, verifies the checksum and installs a single file', async () => {
    const fetch = mockFetch({ 'https://example.test/yt-dlp.exe': 'EXE-BYTES' });
    const log = vi.fn();
    await installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log });
    expect(readFileSync(join(toolsDir, 'yt-dlp.exe'), 'utf8')).toBe('EXE-BYTES');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/yt-dlp 2026\.10\.26.*9 B/);
  });

  it('refuses a download whose checksum does not match, and leaves nothing behind', async () => {
    const fetch = mockFetch({ 'https://example.test/yt-dlp.exe': 'TAMPERED' });
    await expect(installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} })).rejects.toThrow(/checksum/i);
    expect(existsSync(join(toolsDir, 'yt-dlp.exe'))).toBe(false);
    const leftovers = existsSync(toolsDir) ? readdirSync(toolsDir, { recursive: true }) : [];
    expect(leftovers.filter((f) => String(f).includes('yt-dlp'))).toEqual([]);
  });

  it('refuses a tool with no pinned checksum unless --trust-download is given', async () => {
    const fetch = mockFetch({ 'https://example.test/yt-dlp.exe': 'EXE-BYTES' });
    const tools = [fileEntry({ sha256: '' })];
    await expect(installTools({ toolsDir, fetch, tools, extract: vi.fn(), log: () => {} })).rejects.toThrow(/trust-download/);
    expect(fetch).not.toHaveBeenCalled();

    const log = vi.fn();
    await installTools({ toolsDir, fetch, tools, extract: vi.fn(), log, trustDownload: true });
    expect(readFileSync(join(toolsDir, 'yt-dlp.exe'), 'utf8')).toBe('EXE-BYTES');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain(sha('EXE-BYTES'));
  });

  it('refuses any tool URL that is not https, before downloading anything', async () => {
    const fetch = mockFetch({ 'http://example.test/yt-dlp.exe': 'EXE-BYTES' });
    const tools = [fileEntry(), fileEntry({ url: 'http://example.test/yt-dlp.exe' })];
    await expect(installTools({ toolsDir, fetch, tools, extract: vi.fn(), log: () => {} })).rejects.toThrow(/https/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails on a non-OK HTTP status', async () => {
    const fetch = mockFetch({});
    await expect(installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} })).rejects.toThrow(/404/);
  });

  it('is idempotent: a second run downloads nothing', async () => {
    const fetch = mockFetch({ 'https://example.test/yt-dlp.exe': 'EXE-BYTES' });
    await installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} });
    await installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-downloads when the pinned version changes or the file is gone', async () => {
    const fetch = mockFetch({ 'https://example.test/yt-dlp.exe': 'EXE-BYTES', 'https://example.test/v2/yt-dlp.exe': 'EXE-V2' });
    await installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} });
    rmSync(join(toolsDir, 'yt-dlp.exe'));
    await installTools({ toolsDir, fetch, tools: [fileEntry()], extract: vi.fn(), log: () => {} });
    await installTools({
      toolsDir,
      fetch,
      tools: [fileEntry({ version: 'v2', url: 'https://example.test/v2/yt-dlp.exe', sha256: sha('EXE-V2') })],
      extract: vi.fn(),
      log: () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(toolsDir, 'yt-dlp.exe'), 'utf8')).toBe('EXE-V2');
  });

  it('extracts zips into an empty staging folder and installs the named files (with siblings when asked)', async () => {
    const fetch = mockFetch({ 'https://example.test/ffmpeg.zip': 'ZIP1', 'https://example.test/whisper.zip': 'ZIP2' });
    const extract = vi.fn(async (zip: string, dest: string) => {
      expect(readdirSync(dest)).toEqual([]);
      if (readFileSync(zip, 'utf8') === 'ZIP1') {
        mkdirSync(join(dest, 'ffmpeg-9.0.2-essentials_build', 'bin'), { recursive: true });
        for (const f of ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']) writeFileSync(join(dest, 'ffmpeg-9.0.2-essentials_build', 'bin', f), f);
      } else {
        mkdirSync(join(dest, 'Release'), { recursive: true });
        for (const f of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll']) writeFileSync(join(dest, 'Release', f), f);
      }
    });
    const tools: ToolEntry[] = [
      { id: 'ffmpeg', version: '9.0.2', url: 'https://example.test/ffmpeg.zip', sha256: sha('ZIP1'), size: 4, kind: 'zip', files: ['ffmpeg.exe', 'ffprobe.exe'], dest: '.' },
      { id: 'whisper', version: 'b5454', url: 'https://example.test/whisper.zip', sha256: sha('ZIP2'), size: 4, kind: 'zip', files: ['whisper-cli.exe'], dest: 'whisper', withSiblings: true },
    ];
    await installTools({ toolsDir, fetch, tools, extract, log: () => {} });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(toolsDir, 'ffmpeg.exe'), 'utf8')).toBe('ffmpeg.exe');
    expect(readFileSync(join(toolsDir, 'ffprobe.exe'), 'utf8')).toBe('ffprobe.exe');
    expect(existsSync(join(toolsDir, 'ffplay.exe'))).toBe(false);
    expect(readdirSync(join(toolsDir, 'whisper')).sort()).toEqual(['ggml.dll', 'whisper-cli.exe', 'whisper.dll']);
    // Downloads and staging folders are cleaned up.
    expect(readdirSync(toolsDir).sort()).toEqual(['ffmpeg.exe', 'ffprobe.exe', 'manifest.json', 'whisper']);
  });

  it('fails clearly when a zip lacks an expected file', async () => {
    const fetch = mockFetch({ 'https://example.test/ffmpeg.zip': 'ZIP1' });
    const tools: ToolEntry[] = [
      { id: 'ffmpeg', version: '9.0.2', url: 'https://example.test/ffmpeg.zip', sha256: sha('ZIP1'), size: 4, kind: 'zip', files: ['ffmpeg.exe'], dest: '.' },
    ];
    await expect(installTools({ toolsDir, fetch, tools, extract: async () => {}, log: () => {} })).rejects.toThrow(/ffmpeg\.exe/);
  });
});
