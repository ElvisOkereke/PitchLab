import { mkdir } from 'node:fs/promises';

/** Reads the text in each image; returns one string per image, in order. */
export type Ocr = (imagePaths: string[]) => Promise<string[]>;

interface TesseractWorker {
  recognize(image: string): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}
type CreateWorker = (lang?: string, oem?: number, options?: { cachePath?: string }) => Promise<TesseractWorker>;
interface TesseractModule {
  createWorker?: CreateWorker;
  default?: { createWorker?: CreateWorker };
}

const TESSERACT = 'tesseract.js';

/**
 * The default OCR: tesseract.js, imported only when first used (a non-literal specifier keeps bundlers from
 * following it), one English worker per batch, always terminated. The language data is fetched by tesseract.js on
 * first use and cached at `cachePath`.
 */
export function tesseractOcr(deps: { importer?: () => Promise<unknown>; lang?: string; /** Where the language data is cached (default: tesseract.js uses the cwd). */ cachePath?: string } = {}): Ocr {
  return async (imagePaths) => {
    const name = TESSERACT;
    const mod = (await (deps.importer ? deps.importer() : import(/* @vite-ignore */ name))) as TesseractModule;
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (typeof createWorker !== 'function') throw new Error('tesseract.js is not available');
    if (deps.cachePath) await mkdir(deps.cachePath, { recursive: true });
    const worker = await createWorker(deps.lang ?? 'eng', 1, deps.cachePath ? { cachePath: deps.cachePath } : {});
    try {
      const out: string[] = [];
      for (const p of imagePaths) out.push((await worker.recognize(p)).data.text ?? '');
      return out;
    } finally {
      await worker.terminate().catch(() => {});
    }
  };
}

const norm = (line: string) => line.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Splits OCR texts into lines and keeps each distinct line once (first spelling wins; case and spacing ignored).
 * Drops blanks and one-character noise, which OCR produces from video edges and icons.
 */
export function dedupeLines(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/\s+/g, ' ');
      const key = norm(line);
      if (key.length < 2 || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}
