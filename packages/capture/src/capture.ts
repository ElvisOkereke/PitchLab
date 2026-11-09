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
  /** Per-tool timeout; defaults to TOOL_TIMEOUT_MS. */
  timeoutMs?: number;
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
export function captureLink(url: string, opts: CaptureOptions): Promise<CaptureResult> {
  if (!isHttpUrl(url)) return Promise.resolve({ ok: false, platform: 'other', error: 'Only http(s) links can be captured.' });
  const run = queue.then(() => paced(url, opts));
  queue = run.catch(() => {});
  return run;
}

async function paced(url: string, opts: CaptureOptions): Promise<CaptureResult> {
  const platform = detectPlatform(url);
  const now = opts.now ?? Date.now;
  const isPaced = PACED.includes(platform);
  if (isPaced && lastPacedAt !== null) {
    const wait = PACED_GAP_MS - (now() - lastPacedAt);
    if (wait > 0) await (opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
  }
  try {
    return await capture(url, platform, opts);
  } finally {
    if (isPaced) lastPacedAt = now();
  }
}

function describeDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

async function capture(url: string, platform: Platform, opts: CaptureOptions): Promise<CaptureResult> {
  const dirs = { profileDir: opts.profileDir, tmpDir: opts.tmpDir, toolsDir: opts.toolsDir };
  const log = (m: string) => opts.log?.(sanitizeText(m, dirs));
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
    const meta = await runTool(spawn, t.ytdlp, ['--dump-json', '--no-playlist', '--no-warnings', '--no-progress', ...cookies, '--', url], timeoutMs);
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
    const download = ['--no-playlist', '--no-warnings', '--no-progress', '--max-filesize', '200M', '--ffmpeg-location', opts.toolsDir];
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
          screenText = dedupeLines(await (opts.ocr ?? tesseractOcr({ cachePath: join(opts.toolsDir, 'tesseract') }))(frames)).join('\n').slice(0, MAX_SCREEN_TEXT);
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
    const page = await opts.readPage(url);
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
