import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * The pinned Windows x64 tools that `npm run capture:setup` downloads into `.tools/`. Each SHA-256 is the digest the
 * publisher reports for that exact file (GitHub release asset digest; Hugging Face LFS oid for the model, pinned to a
 * repository commit), recorded on 2026-11-08. Setup refuses any download that does not match, and refuses an entry
 * with an empty checksum unless `--trust-download` is passed.
 */
export interface ToolEntryBase {
  id: string;
  version: string;
  url: string;
  /** Lowercase hex SHA-256 of the downloaded file. Empty means "not pinned": setup refuses without --trust-download. */
  sha256: string;
  /** Expected download size in bytes (informational; printed by setup). */
  size: number;
}
export type ToolEntry =
  | (ToolEntryBase & { kind: 'file'; /** Path under the tools dir. */ target: string })
  | (ToolEntryBase & {
      kind: 'zip';
      /** File names to find anywhere in the archive. */
      files: string[];
      /** Folder under the tools dir to put them in ('.' for the tools dir itself). */
      dest: string;
      /** Also copy every other file next to the first named file (DLLs the exe needs). */
      withSiblings?: boolean;
    });

export const TOOLS: ToolEntry[] = [
  {
    id: 'yt-dlp',
    version: '2026.10.26',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe',
    sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
    size: 23_575_744,
    kind: 'file',
    target: 'yt-dlp.exe',
  },
  {
    id: 'ffmpeg',
    version: '9.0.2',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
    sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    size: 114_768_076,
    kind: 'zip',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    dest: '.',
  },
  {
    // whisper.cpp v1.9.5 ships its Windows binaries under the build tag b5454.
    id: 'whisper',
    version: 'b5454',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    size: 8_928_640,
    kind: 'zip',
    files: ['whisper-cli.exe'],
    dest: 'whisper',
    withSiblings: true,
  },
  {
    // ggml `base` multilingual model, pinned to a commit of ggerganov/whisper.cpp on Hugging Face.
    id: 'model',
    version: '5359861c739e955e79d9a303bcbc70fb988958b1',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    size: 147_951_465,
    kind: 'file',
    target: 'models/ggml-base.bin',
  },
];

/** Where each installed tool lives under the tools dir (matches TOOLS above). */
export function toolPaths(toolsDir: string) {
  return {
    ytdlp: join(toolsDir, 'yt-dlp.exe'),
    ffmpeg: join(toolsDir, 'ffmpeg.exe'),
    ffprobe: join(toolsDir, 'ffprobe.exe'),
    whisperCli: join(toolsDir, 'whisper', 'whisper-cli.exe'),
    model: join(toolsDir, 'models', 'ggml-base.bin'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Running a tool

export interface StreamLike {
  on(event: 'data', fn: (chunk: Buffer | string) => void): unknown;
}
export interface ChildLike {
  pid?: number;
  stdout: StreamLike | null;
  stderr: StreamLike | null;
  on(event: 'close', fn: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}
export interface SpawnOptionsLike {
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
}
export type SpawnLike = (command: string, args: string[], options: SpawnOptionsLike) => ChildLike;

export const defaultSpawn: SpawnLike = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildLike;

export interface ToolRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not start (e.g. ENOENT: the exe is missing). */
  startError?: NodeJS.ErrnoException;
}

/** Keeps the tail of stderr and the head of stdout bounded (yt-dlp JSON can run to a few MB). */
const MAX_STDOUT = 32 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/**
 * Runs one tool with an argument array (never a shell) and kills it after `timeoutMs`. On Windows the whole process
 * tree is killed with taskkill, since yt-dlp.exe is a launcher with a child process and runs ffmpeg itself.
 */
export function runTool(spawn: SpawnLike, command: string, args: string[], timeoutMs: number): Promise<ToolRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (run: Omit<ToolRun, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ ...run, stdout, stderr, timedOut });
    };
    let child: ChildLike;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ code: null, startError: err as NodeJS.ErrnoException });
      return;
    }
    child.stdout?.on('data', (c) => {
      if (stdout.length < MAX_STDOUT) stdout += String(c);
    });
    child.stderr?.on('data', (c) => {
      stderr = (stderr + String(c)).slice(-MAX_STDERR);
    });
    child.on('error', (err) => finish({ code: null, startError: err as NodeJS.ErrnoException }));
    child.on('close', (code) => finish({ code }));
    timer = setTimeout(() => {
      timedOut = true;
      // Tree kill is Windows-only, like the tools themselves (capture:setup installs Windows x64 binaries only).
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        try {
          defaultSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).on('error', () => {});
        } catch {
          // Fall through to child.kill below.
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      // If 'close' never arrives, stop waiting anyway.
      grace = setTimeout(() => finish({ code: null }), 5_000);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitising tool output

export interface SanitizeDirs {
  profileDir?: string;
  tmpDir?: string;
  toolsDir?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regex for a directory path that matches either slash style, case-insensitively, plus the rest of the path. */
function dirPattern(dir: string): RegExp {
  const parts = dir.split(/[\\/]+/).filter(Boolean).map(escapeRe);
  return new RegExp(`${parts.join('[\\\\/]+')}[^\\s"'<>]*`, 'gi');
}

const SECRET_NAME = '[\\w.-]*(?:token|session|csrf|cookie|auth|key|secret|passw|sig|ds_user_id|sid)[\\w.-]*';

/**
 * Makes tool stderr safe to show or store: removes paths under the profile, tmp and tools dirs (and any other
 * absolute path or anything under `.data`), redacts cookies, tokens, keys and signed URL query strings, and caps the
 * length. Prefers the tool's ERROR lines when there are any.
 */
export function sanitizeError(raw: string, dirs: SanitizeDirs = {}, max = 500): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter((l) => /^error\b/i.test(l));
  return sanitizeText((errorLines.length ? errorLines : lines.slice(-6)).join('\n'), dirs, max);
}

/** The redactions of sanitizeError, applied to the whole text (for log lines). */
export function sanitizeText(raw: string, dirs: SanitizeDirs = {}, max = 2000): string {
  let s = raw;
  for (const d of [dirs.profileDir, dirs.tmpDir, dirs.toolsDir]) if (d && d.length > 3) s = s.replace(dirPattern(d), '<dir>');
  s = s
    // Signed CDN URLs carry their credentials in the query string.
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1?<redacted>')
    .replace(/\b(set-cookie|cookie|authorization|proxy-authorization)\s*:[^\n]*/gi, '$1: <redacted>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s;&,]+)`, 'gi'), '$1$2<redacted>')
    // Windows absolute paths, then any leftover path fragment with a backslash (paths with spaces), then .data.
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '<path>')
    .replace(/[^\s"'<>]*\\[^\s"'<>]*/g, '<path>')
    .replace(/[^\s"'<>]*\.data\b[^\s"'<>]*/gi, '<path>')
    .replace(/(^|[\s"'(=])\/(?:home|Users|tmp|var|root|mnt|private|opt|etc|srv|media)\/[^\s"'<>]*/g, '$1<path>')
    // Long opaque strings (hashes, session ids, API keys).
    .replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>');
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
