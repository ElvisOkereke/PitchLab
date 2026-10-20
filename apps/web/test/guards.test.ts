import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardRoot = fileURLToPath(new URL('../../../packages/core/src/dashboard', import.meta.url));
const SKIP = new Set(['node_modules', '.next', 'test']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;

/** Every source file under `dir`, skipping node_modules/.next anywhere and the top-level test folder. */
function walk(dir: string, top = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const skip = e.name === 'node_modules' || e.name === '.next' || (dir === top && SKIP.has(e.name));
      return skip ? [] : walk(full, top);
    }
    return SOURCE.test(e.name) ? [full] : [];
  });
}

// Built from parts so this file never matches its own patterns if the walk ever changes.
const FORBIDDEN = [['dangerously', 'SetInnerHTML'], ['sql', '.raw'], ['NEXT', '_PUBLIC_']].map((p) => p.join(''));

describe('source guards', () => {
  const files = [...walk(webRoot), ...walk(dashboardRoot)];

  it('scans the web app and the core dashboard modules', () => {
    expect(files.some((f) => f.endsWith('next.config.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('board.ts'))).toBe(true);
  });

  it('shows no literal backticks in JSX text — commands go in <code> or plain text', () => {
    const hits = files.filter((f) => f.endsWith('.tsx')).flatMap((f) => {
      // Comments may quote code in backticks; only rendered text counts.
      const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // Text between two tags (no braces, so template literals inside {…} do not count; `=>` is not a tag end).
      return [...text.matchAll(/(?<!=)>([^<>{}]*`[^<>{}]*)</g)].map((m) => `${relative(webRoot, f)}: ${m[1]!.trim().slice(0, 60)}`);
    });
    expect(hits).toEqual([]);
  });

  it('allow-listed notices contain no literal backticks', async () => {
    const { BOARD_NOTICES } = await import('@/lib/board-query');
    const { CASE_NOTICES } = await import('@/lib/case-query');
    const { RUNS_NOTICES } = await import('@/lib/runs-query');
    const messages = [...Object.values(BOARD_NOTICES), ...Object.values(CASE_NOTICES), ...Object.values(RUNS_NOTICES)];
    expect(messages.length).toBeGreaterThan(5);
    expect(messages.filter((m) => m.includes('`'))).toEqual([]);
  });

  it('never uses dangerouslySetInnerHTML, sql.raw or NEXT_PUBLIC_', () => {
    const hits = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return FORBIDDEN.filter((p) => text.includes(p)).map((p) => `${relative(webRoot, f)}: ${p}`);
    });
    expect(hits).toEqual([]);
  });
});
