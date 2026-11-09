// npm run capture:setup [-- --trust-download]
// Downloads the pinned Windows x64 capture tools (yt-dlp, ffmpeg + ffprobe, whisper.cpp and the ggml base model,
// about 300 MB) into .tools/ at the repo root, verifies each SHA-256 against the TOOLS table in src/tools.ts, and
// records what is installed in .tools/manifest.json so a second run downloads nothing. A download whose checksum
// does not match is deleted and setup stops. An entry with an empty checksum is refused unless --trust-download is
// passed, in which case the computed checksum is printed so it can be pinned.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOOLS, type ToolEntry } from '../src/tools';

export type { ToolEntry } from '../src/tools';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Extracts `zip` into the (new, empty) folder `dest`. */
export type Extract = (zip: string, dest: string) => Promise<void>;

interface Manifest {
  [id: string]: { version: string; sha256: string };
}

export interface InstallOptions {
  toolsDir: string;
  fetch: FetchLike;
  tools?: ToolEntry[];
  extract?: Extract;
  log?: (line: string) => void;
  trustDownload?: boolean;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function outputsOf(t: ToolEntry, toolsDir: string): string[] {
  return t.kind === 'file' ? [join(toolsDir, t.target)] : t.files.map((f) => join(toolsDir, t.dest, f));
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

async function sizeOf(paths: string[]): Promise<number> {
  let total = 0;
  for (const p of paths) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  return total;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

async function moveFile(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Streams a download to `dest` while hashing it; returns the hex SHA-256 and the byte count. */
async function download(fetch: FetchLike, t: ToolEntry, dest: string): Promise<{ sha256: string; bytes: number }> {
  const res = await fetch(t.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${t.id}: download failed (HTTP ${res.status}) from ${t.url}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const fh = await open(dest, 'w');
  try {
    for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      await fh.write(buf);
    }
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Installs every tool that is missing or at a different pinned version. Throws on the first failure. */
export async function installTools(opts: InstallOptions): Promise<void> {
  const tools = opts.tools ?? TOOLS;
  const log = opts.log ?? ((l: string) => console.log(l));
  const extract = opts.extract ?? windowsExtract;
  const insecure = tools.filter((t) => !t.url.startsWith('https://'));
  if (insecure.length) throw new Error(`Tool URLs must use https: ${insecure.map((t) => `${t.id} (${t.url})`).join(', ')}`);
  const unpinned = tools.filter((t) => !/^[0-9a-f]{64}$/.test(t.sha256));
  if (unpinned.length && !opts.trustDownload) {
    throw new Error(
      `No pinned SHA-256 for ${unpinned.map((t) => t.id).join(', ')}; refusing to install unverified binaries. ` +
        'Re-run with --trust-download to accept the downloads and print their checksums for pinning.',
    );
  }
  const manifestPath = join(opts.toolsDir, 'manifest.json');
  const downloads = join(opts.toolsDir, '.downloads');
  const staging = join(opts.toolsDir, '.staging');
  await mkdir(opts.toolsDir, { recursive: true });
  const manifest = await readManifest(manifestPath);
  try {
    for (const t of tools) {
      const outputs = outputsOf(t, opts.toolsDir);
      const have = manifest[t.id];
      if (have && have.version === t.version && (!t.sha256 || have.sha256 === t.sha256) && outputs.every((p) => existsSync(p))) {
        log(`${t.id} ${t.version}: already installed (${formatSize(await sizeOf(outputs))})`);
        continue;
      }
      log(`${t.id} ${t.version}: downloading ${formatSize(t.size)} from ${t.url}`);
      await mkdir(downloads, { recursive: true });
      const file = join(downloads, `${t.id}-${randomBytes(6).toString('hex')}.download`);
      try {
        const got = await download(opts.fetch, t, file);
        if (t.sha256 && got.sha256 !== t.sha256) {
          throw new Error(`${t.id}: checksum mismatch (expected ${t.sha256}, got ${got.sha256}); the download was deleted.`);
        }
        if (!t.sha256) log(`${t.id}: SHA-256 ${got.sha256} (not pinned; accepted because of --trust-download)`);
        if (t.kind === 'file') {
          await moveFile(file, outputs[0]);
        } else {
          const box = join(staging, `${t.id}-${randomBytes(6).toString('hex')}`);
          await mkdir(box, { recursive: true });
          try {
            await extract(file, box);
            const all = await walk(box);
            const found = t.files.map((name) => {
              const hit = all.find((p) => basename(p).toLowerCase() === name.toLowerCase());
              if (!hit) throw new Error(`${t.id}: ${name} not found in the downloaded archive.`);
              return hit;
            });
            const destDir = join(opts.toolsDir, t.dest);
            await mkdir(destDir, { recursive: true });
            const toCopy = t.withSiblings ? all.filter((p) => dirname(p) === dirname(found[0])) : found;
            for (const p of toCopy) await copyFile(p, join(destDir, basename(p)));
          } finally {
            await rm(box, { recursive: true, force: true });
          }
        }
        manifest[t.id] = { version: t.version, sha256: got.sha256 };
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`${t.id} ${t.version}: installed (${formatSize(await sizeOf(outputs))})`);
      } finally {
        await rm(file, { force: true });
      }
    }
  } finally {
    await rm(downloads, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/** Extracts with Windows' built-in bsdtar (System32\tar.exe), which refuses absolute and `..` entry paths. */
export const windowsExtract: Extract = (zip, dest) =>
  new Promise((resolvePromise, reject) => {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const child = spawn(tar, ['-xf', zip, '-C', dest], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr = (stderr + String(c)).slice(-2000)));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`extracting ${basename(zip)} failed (exit ${code}): ${stderr.trim()}`));
    });
  });

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.error('capture:setup downloads Windows x64 tools and only runs on Windows x64.');
    process.exit(1);
  }
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const toolsDir = join(root, '.tools');
  const trustDownload = process.argv.includes('--trust-download');
  try {
    await installTools({ toolsDir, fetch: (url, init) => globalThis.fetch(url, init), trustDownload });
    console.log(`Capture tools are ready in ${toolsDir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
