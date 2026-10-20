// The web layer may import only web-safe core modules: following every runtime (non-type) import from apps/web into
// packages/core/src must never reach the model router or adapters, the page fetcher, the source clients, the env
// loader, the CLI, PGlite or the LLM SDKs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const coreSrc = fileURLToPath(new URL('../../../packages/core/src', import.meta.url));

const FORBIDDEN_MODULES = [
  'llm/router', 'llm/anthropic', 'llm/openai', 'llm/retry', 'llm/prompts', 'tools/fetch-page', 'tools/sources', 'tools/github-issue',
  'config/env', 'cli', 'db/client', 'db/migrate', 'db/test-db', 'pipeline/deps', 'worker', 'validation/outreach', 'validation/emails',
];
const FORBIDDEN_PACKAGES = ['@anthropic-ai/sdk', 'openai', 'undici', '@mozilla/readability', 'linkedom', '@electric-sql/pglite', 'commander'];

/** Runtime import specifiers of a source file (whole-statement `import type` / `export type` are skipped). */
function runtimeImports(text: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
  for (const m of text.matchAll(re)) {
    if (m[2]) continue;
    const spec = m[4] ?? m[5] ?? m[6];
    // `import { type A, type B } from` is erased too.
    if (m[3] && /^\{[^}]*\}$/.test(m[3].trim()) && m[3].replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type'))) continue;
    if (spec) out.push(spec);
  }
  return out;
}

function coreFile(spec: string, fromDir?: string): string | null {
  const base = fromDir ? resolve(fromDir, spec) : join(coreSrc, spec.slice('@bcg/core/'.length));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate;
  return null;
}

function webSources(dir: string, top = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '.next'].includes(e.name) || (dir === top && ['test', 'scripts'].includes(e.name)) ? [] : webSources(full, top);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe('web-safe core imports', () => {
  it('no runtime import path from apps/web reaches a server-side-only core module or SDK', () => {
    const seen = new Set<string>();
    const queue: { file: string; via: string }[] = [];
    const problems: string[] = [];
    for (const f of webSources(webRoot)) {
      for (const spec of runtimeImports(readFileSync(f, 'utf8'))) {
        if (!spec.startsWith('@bcg/core/')) continue;
        const target = coreFile(spec);
        if (!target) problems.push(`${relative(webRoot, f)}: cannot resolve ${spec}`);
        else queue.push({ file: target, via: relative(webRoot, f) });
      }
    }
    expect(queue.length).toBeGreaterThan(5);
    while (queue.length) {
      const { file, via } = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const mod = relative(coreSrc, file).replaceAll('\\', '/').replace(/\.ts$/, '');
      if (FORBIDDEN_MODULES.some((m) => mod === m || mod.startsWith(`${m}/`))) problems.push(`${via} → ${mod}`);
      for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const next = coreFile(spec, dirname(file));
          if (next) queue.push({ file: next, via: `${via} → ${mod}` });
        } else if (FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
          problems.push(`${via} → ${mod} → ${spec}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the scanner sees through type-only imports but catches runtime ones', () => {
    expect(runtimeImports("import type { Db } from '@bcg/core/db/client';\nimport { type A } from 'x';")).toEqual([]);
    expect(runtimeImports("import { a, type B } from 'y';\nimport 'z';\nexport { c } from 'w';")).toEqual(['y', 'z', 'w']);
  });
});
