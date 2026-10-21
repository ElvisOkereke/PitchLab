import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAPTERS } from '@/lib/tour/chapters';

// Every tour target is a `data-tour` literal in exactly one component file, and every literal is used by a step.
// Matches JSX attributes (data-tour="x"), first-item-only attributes (data-tour={first ? 'x' : undefined}) and props
// objects spread onto links ('data-tour': 'x').
const ANCHOR = /data-tour['"]?\s*[=:]\s*(?:\{[^}'"?]*\?\s*)?['"]([a-z0-9-]+)['"]/g;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** anchor id → the files that define it. */
const defined = new Map<string, Set<string>>();
for (const file of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))]) {
  for (const m of readFileSync(file, 'utf8').matchAll(ANCHOR)) {
    const files = defined.get(m[1]!) ?? new Set<string>();
    files.add(file);
    defined.set(m[1]!, files);
  }
}

const steps = Object.values(CHAPTERS).flatMap((c) => c.steps);
const used = new Set(steps.flatMap((s) => [s.target, s.advanceOn?.appears].filter((x): x is string => typeof x === 'string')));

describe('tour anchors', () => {
  it('finds anchors in the source (the scan works)', () => {
    expect(defined.size).toBeGreaterThan(10);
    expect(defined.has('validate-generate')).toBe(true);
  });

  it('every step target and "appears" id is a data-tour attribute in exactly one source file', () => {
    for (const id of used) expect([id, defined.get(id)?.size ?? 0]).toEqual([id, 1]);
  });

  it('every data-tour attribute in the source is used by some step', () => {
    for (const id of defined.keys()) expect([id, used.has(id)]).toEqual([id, true]);
  });
});
