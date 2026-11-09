import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dedupeLines, tesseractOcr, type Ocr } from './ocr';
import { detectPlatform, isHttpUrl, type Platform } from './platform';
import { defaultSpawn, runTool, sanitizeError, sanitizeText, toolPaths, type SpawnLike, type ToolRun } from './tools';

/** Every external tool is killed after this long. */
export const TOOL_TIMEOUT_MS = 180_000;
/** Minimum gap between two Instagram or TikTok captures. */
export const PACED_GAP_MS = 20_000;
export const MAX_FRAMES = 20;
const PACED: Platform[] = ['instagram', 'tiktok'];
const COOKIE_PLATFORMS: Platform[] = ['instagram', 'facebook'];
const MAX_CAPTION = 20_000;
const MAX_TRANSCRIPT = 50_000;
const MAX_SCREEN_TEXT = 10_000;

export interface CaptureStats {
  views?: number;
  likes?: number;
  comments?: number;
  durationSec?: number;
  /** YYYY-MM-DD */
  uploadedAt?: string;
}

export interface CaptureFallback {
  caption?: string;
  pageText?: string;
}

export type CaptureResult =
  | {
      ok: true;
      platform: Platform;
      title: string;
      caption: string;
      transcript: string;
      screenText: string;
      stats: CaptureStats;
      language?: string;
      /** Steps after the metadata that failed (sanitised); the capture still counts. */
      warnings: string[];
    }
  | { ok: false; platform: Platform; error: string; fallback?: CaptureFallback };

export interface CaptureOptions {
  /** Where `npm run capture:setup` put the tools (`.tools/`). */
  toolsDir: string;
  /** The capture browser profile (`.data/capture-profile`); the only cookie source. */
  profileDir: string;
  /** Parent of the per-capture work folder, which is always deleted afterwards. */
  tmpDir: string;
  spawn?: SpawnLike;
  ocr?: Ocr;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines, already sanitised. */
  log?: (message: string) => void;
  /** Reads the page itself when yt-dlp cannot (core supplies one built on its guarded page fetch). */
  readPage?: (url: string) => Promise<CaptureFallback | null | undefined>;
  /** Per-tool timeout (also bounds readPage and OCR); defaults to TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Proxy for every yt-dlp request. Core passes its guarded proxy, which refuses private addresses on every hop, so
   * yt-dlp's own redirects and CDN fetches stay bounded by the SSRF guard.
   */
  proxyUrl?: string;
  /** Extra URL policy (core: banned and never-fetch hosts). false refuses the capture before anything runs. */
  checkUrl?: (url: string) => Promise<boolean>;
}

/** Platforms yt-dlp is used for; any other site goes straight to readPage. */
const YTDLP_PLATFORMS: Platform[] = ['instagram', 'tiktok', 'youtube', 'x', 'threads', 'facebook', 'linkedin'];
const LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  other: 'Web',
};

/**
 * True when the host must never be captured from this package: IP literals (v4, v6 and the numeric forms the URL
 * parser normalises), localhost, single-label names and .local / .internal / .localhost names. Core's guarded proxy
 * and checkUrl add DNS-level checks on top.
 */
export function isLocalOrPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return true;
  }
  if (!host) return true;
  if (host.startsWith('[') || host.includes(':')) return true;
  if (/^\d+(\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (!host.includes('.')) return true;
  return host === 'localhost' || /\.(localhost|local|internal)$/.test(host);
}

/** Settles with `onTimeout()` (which may throw) if `p` has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (err) {
          reject(err);
        }
      }, ms);
    }),
  ]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces each creator handle or name (case-insensitive, with or without @) with "the creator". Names shorter than
 * 3 characters are left alone so ordinary words are not rewritten.
 */
export function scrubHandles(text: string, handles: string[]): string {
  const list = [...new Set(handles.map((h) => h.trim().replace(/^@/, '')).filter((h) => h.length >= 3))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const h of list) out = out.replace(new RegExp(`(?<![\\w.@])@?${escapeRe(h)}(?![\\w])`, 'gi'), 'the creator');
  return out;
}

/** Drops "Video by …" / "Reel by …" / "Post by …" boilerplate (after handles are scrubbed). */
function cleanTitle(title: string, platform: Platform): string {
  const t = title.replace(/^(?:video|reel|post|photo|clip)s?\s+by\s+(?:the creator|\S+)\s*(?:[:|\-–—]\s*)?/i, '').trim();
  return t || `${LABELS[platform]} video`;
}

/** Instagram path segments that are not profile names. */
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'share', 's']);

/**
 * Creator names known from the URL before any metadata: @handles in the path (TikTok, Threads, YouTube), and Instagram
 * profile names (instagram.com/<name>/…, instagram.com/stories/<name>/…).
 */
function handlesInUrl(url: string): string[] {
  try {
    const u = new URL(url);
    const out = [...u.pathname.matchAll(/\/@([\w.-]+)/g)].map((m) => m[1]);
    if (detectPlatform(url) === 'instagram') {
      const parts = u.pathname.split('/').filter(Boolean);
      const name = parts[0] === 'stories' ? parts[1] : parts[0];
      if (name && !INSTAGRAM_RESERVED.has(name.toLowerCase()) && /^[\w.]+$/.test(name)) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

// One capture at a time, process-wide, with pacing between Instagram/TikTok captures.
let queue: Promise<unknown> = Promise.resolve();
let lastPacedAt: number | null = null;

/** Clears the one-at-a-time queue and pacing clock (tests). */
export function resetCapturePacing(): void {
  queue = Promise.resolve();
  lastPacedAt = null;
}

/**
 * Captures a shared link: metadata and stats via yt-dlp, a transcript via ffmpeg + whisper-cli, on-screen text via
 * ffmpeg frames + OCR. Never throws. A metadata failure returns ok:false (with the readPage fallback when given);
 * later steps that fail become warnings.
 */
export async function captureLink(url: string, opts: CaptureOptions): Promise<CaptureResult> {
  if (!isHttpUrl(url)) return { ok: false, platform: 'other', error: 'Only http(s) links can be captured.' };
  const platform = detectPlatform(url);
  if (isLocalOrPrivateHost(url)) return { ok: false, platform, error: 'That address is not allowed (local or private host).' };
  if (opts.checkUrl) {
    // A policy check that never answers refuses the capture (bounded like every other step).
    const allowed = await withTimeout(opts.checkUrl(url).catch(() => false), opts.timeoutMs ?? TOOL_TIMEOUT_MS, () => false);
    if (!allowed) return { ok: false, platform, error: 'That address is not allowed.' };
  }
  const run = queue.then(() => paced(url, platform, opts));
  queue = run.catch(() => {});
  return run;
}

async function paced(url: string, platform: Platform, opts: CaptureOptions): Promise<CaptureResult> {
  if (!YTDLP_PLATFORMS.includes(platform)) {
    return withFallback({ ok: false, platform, error: 'Not a supported video platform; read as a page instead.' }, url, opts);
  }
  const now = opts.now ?? Date.now;
  const isPaced = PACED.includes(platform);
  if (isPaced && lastPacedAt !== null) {
    const wait = PACED_GAP_MS - (now() - lastPacedAt);
    if (wait > 0) await (opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
  }
  const handles = handlesInUrl(url);
  try {
    return scrubResult(await capture(url, platform, opts, handles), handles);
  } finally {
    if (isPaced) lastPacedAt = now();
  }
}

function describeDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function scrubResult(res: CaptureResult, handles: string[]): CaptureResult {
  const s = (t: string) => scrubHandles(t, handles);
  if (!res.ok) {
    const out: CaptureResult = { ok: false, platform: res.platform, error: s(res.error) };
    if (res.fallback) {
      out.fallback = {};
      if (res.fallback.caption) out.fallback.caption = s(res.fallback.caption);
      if (res.fallback.pageText) out.fallback.pageText = s(res.fallback.pageText);
    }
    return out;
  }
  return {
    ...res,
    title: cleanTitle(s(res.title), res.platform),
    caption: s(res.caption),
    transcript: s(res.transcript),
    screenText: s(res.screenText),
    warnings: res.warnings.map(s),
  };
}

async function capture(url: string, platform: Platform, opts: CaptureOptions, handles: string[]): Promise<CaptureResult> {
  const dirs = { profileDir: opts.profileDir, tmpDir: opts.tmpDir, toolsDir: opts.toolsDir };
  const log = (m: string) => opts.log?.(scrubHandles(sanitizeText(m, dirs), handles));
  // Never read yt-dlp config files or plugins from this machine (a config could add options such as --exec).
  const yt = ['--ignore-config', '--no-plugin-dirs', ...(opts.proxyUrl ? ['--proxy', opts.proxyUrl] : [])];
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS;
  const t = toolPaths(opts.toolsDir);
  const cookies = COOKIE_PLATFORMS.includes(platform) ? ['--cookies-from-browser', `chromium:${opts.profileDir}`] : [];

  /** A readable, sanitised reason a tool run failed, or null when it succeeded. */
  const failure = (name: string, run: ToolRun): string | null => {
    if (run.startError) {
      return run.startError.code === 'ENOENT'
        ? `${name} is not installed. Run npm run capture:setup.`
        : `${name} could not start: ${sanitizeError(run.startError.message, dirs)}`;
    }
    if (run.timedOut) return `${name} timed out after ${describeDuration(timeoutMs)} and was stopped.`;
    if (run.code !== 0) return `${name} failed: ${sanitizeError(run.stderr, dirs) || `exit code ${run.code}`}`;
    return null;
  };

  let work: string | undefined;
  try {
    log(`capture: reading ${platform} metadata`);
    const meta = await runTool(spawn, t.ytdlp, [...yt, '--dump-json', '--no-playlist', '--no-warnings', '--no-progress', ...cookies, '--', url], timeoutMs);
    let info: Record<string, unknown> | null = null;
    let error = failure('yt-dlp', meta);
    if (!error) {
      try {
        const first = meta.stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
        info = first ? (JSON.parse(first) as Record<string, unknown>) : null;
      } catch {
        info = null;
      }
      if (!info) error = 'yt-dlp returned no readable metadata.';
    }
    if (info) for (const k of ['uploader', 'uploader_id', 'channel', 'creator']) if (typeof info[k] === 'string') handles.push(info[k] as string);
    if (error || !info) {
      log(`capture: ${error}`);
      return withFallback({ ok: false, platform, error: error ?? 'yt-dlp failed.' }, url, opts);
    }

    await mkdir(opts.tmpDir, { recursive: true });
    work = await mkdtemp(join(opts.tmpDir, 'capture-'));
    const warnings: string[] = [];
    const warn = (w: string) => {
      warnings.push(w);
      log(`capture: ${w}`);
    };
    // --max-filesize is not a hard cap for fragmented (HLS/DASH) streams; the per-tool timeout bounds those.
    const download = [...yt, '--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', '200M', '--ffmpeg-location', opts.toolsDir];
    const findFile = async (prefix: string) =>
      (await readdir(work!)).filter((f) => f.startsWith(`${prefix}.`) && !/\.(part|ytdl|wav|json)$/i.test(f)).map((f) => join(work!, f))[0];

    log('capture: downloading audio');
    const audioRun = await runTool(spawn, t.ytdlp, [...download, '-f', 'bestaudio/best', '-o', join(work, 'audio.%(ext)s'), ...cookies, '--', url], timeoutMs);
    const audioErr = failure('yt-dlp (audio)', audioRun);
    if (audioErr) warn(audioErr);
    log('capture: downloading low-resolution video');
    const videoRun = await runTool(
      spawn,
      t.ytdlp,
      [...download, '-f', 'bv*[height<=480]/b[height<=480]/worst', '-o', join(work, 'video.%(ext)s'), ...cookies, '--', url],
      timeoutMs,
    );
    const videoErr = failure('yt-dlp (video)', videoRun);
    if (videoErr) warn(videoErr);

    const ff = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    let transcript = '';
    let language: string | undefined;
    const audio = await findFile('audio');
    if (audio) {
      const wav = join(work, 'audio.wav');
      log('capture: converting audio');
      const wavErr = failure('ffmpeg (audio)', await runTool(spawn, t.ffmpeg, [...ff, '-i', audio, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], timeoutMs));
      if (wavErr) warn(wavErr);
      else if (existsSync(wav)) {
        log('capture: transcribing');
        const base = join(work, 'transcript');
        const wErr = failure('whisper', await runTool(spawn, t.whisperCli, ['-m', t.model, '-f', wav, '-l', 'auto', '-oj', '-of', base, '-np'], timeoutMs));
        if (wErr) warn(wErr);
        else {
          try {
            const j = JSON.parse(await readFile(`${base}.json`, 'utf8')) as { result?: { language?: unknown }; transcription?: { text?: unknown }[] };
            transcript = (j.transcription ?? [])
              .map((s) => (typeof s.text === 'string' ? s.text.trim() : ''))
              .filter(Boolean)
              .join(' ')
              .slice(0, MAX_TRANSCRIPT);
            if (typeof j.result?.language === 'string' && j.result.language) language = j.result.language;
          } catch {
            warn('whisper produced no readable transcript.');
          }
        }
      }
    }

    let screenText = '';
    const video = await findFile('video');
    if (video) {
      log('capture: sampling frames');
      const fErr = failure('ffmpeg (frames)', await runTool(spawn, t.ffmpeg, [...ff, '-i', video, '-vf', 'fps=1/2', '-frames:v', String(MAX_FRAMES), join(work, 'frame-%03d.png')], timeoutMs));
      if (fErr) warn(fErr);
      const frames = (await readdir(work))
        .filter((f) => /^frame-\d+\.png$/.test(f))
        .sort()
        .slice(0, MAX_FRAMES)
        .map((f) => join(work!, f));
      if (frames.length) {
        log(`capture: reading on-screen text from ${frames.length} frames`);
        try {
          const ocr = opts.ocr ?? tesseractOcr({ cachePath: join(opts.toolsDir, 'tesseract') });
          const texts = await withTimeout(ocr(frames), timeoutMs, () => {
            throw new Error(`OCR timed out after ${describeDuration(timeoutMs)}`);
          });
          screenText = dedupeLines(texts).join('\n').slice(0, MAX_SCREEN_TEXT);
        } catch (err) {
          warn(`on-screen text failed: ${sanitizeError(err instanceof Error ? err.message : String(err), dirs)}`);
        }
      }
    }

    const result: CaptureResult = {
      ok: true,
      platform,
      title: str(info.title).slice(0, 500),
      caption: str(info.description).slice(0, MAX_CAPTION),
      transcript,
      screenText,
      stats: statsOf(info),
      warnings,
    };
    if (language) result.language = language;
    log('capture: done');
    return result;
  } catch (err) {
    const error = `capture failed: ${sanitizeError(err instanceof Error ? err.message : String(err), dirs)}`;
    log(error);
    return withFallback({ ok: false, platform, error }, url, opts);
  } finally {
    if (work) await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function withFallback(
  res: { ok: false; platform: Platform; error: string },
  url: string,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  if (!opts.readPage) return res;
  try {
    const page = await withTimeout(opts.readPage(url), opts.timeoutMs ?? TOOL_TIMEOUT_MS, () => null);
    const fallback: CaptureFallback = {};
    if (page?.caption) fallback.caption = page.caption.slice(0, MAX_CAPTION);
    if (page?.pageText) fallback.pageText = page.pageText.slice(0, MAX_TRANSCRIPT);
    return fallback.caption || fallback.pageText ? { ...res, fallback } : res;
  } catch {
    return res;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function statsOf(info: Record<string, unknown>): CaptureStats {
  const stats: CaptureStats = {};
  const views = num(info.view_count);
  const likes = num(info.like_count);
  const comments = num(info.comment_count);
  const durationSec = num(info.duration);
  if (views !== undefined) stats.views = views;
  if (likes !== undefined) stats.likes = likes;
  if (comments !== undefined) stats.comments = comments;
  if (durationSec !== undefined) stats.durationSec = durationSec;
  const d = info.upload_date;
  if (typeof d === 'string' && /^\d{8}$/.test(d)) stats.uploadedAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  else if (num(info.timestamp) !== undefined) stats.uploadedAt = new Date((info.timestamp as number) * 1000).toISOString().slice(0, 10);
  return stats;
}
