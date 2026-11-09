import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { captureLink, resetCapturePacing, TOOL_TIMEOUT_MS, PACED_GAP_MS, MAX_FRAMES } from './capture';
export type { CaptureOptions, CaptureResult, CaptureStats, CaptureFallback } from './capture';
export { detectPlatform, isHttpUrl, type Platform } from './platform';
export { sanitizeError, sanitizeText, toolPaths, TOOLS, type SpawnLike, type ToolEntry } from './tools';
export { tesseractOcr, dedupeLines, type Ocr } from './ocr';

/** The repo root (this file is packages/capture/src/index.ts). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** The standard locations: `.tools/`, `.data/capture-profile`, and a temp parent for work folders. */
export function defaultCaptureDirs(root = REPO_ROOT) {
  return {
    toolsDir: join(root, '.tools'),
    profileDir: join(root, '.data', 'capture-profile'),
    tmpDir: join(tmpdir(), 'bcg-capture'),
  };
}
