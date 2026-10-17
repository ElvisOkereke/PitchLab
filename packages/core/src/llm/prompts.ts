import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export type LoadedPrompt = { version: string; render(vars: Record<string, string>): string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Loads the highest `prompts/<name>.v<N>.md`; `{{var}}` substitution that throws on unknown/unfilled vars. */
export function loadPrompt(name: string): LoadedPrompt {
  const re = new RegExp(`^${escapeRe(name)}\\.v(\\d+)\\.md$`);
  let best = -1;
  for (const f of readdirSync(PROMPTS_DIR)) {
    const m = re.exec(f);
    if (m) best = Math.max(best, Number(m[1]));
  }
  if (best < 0) throw new Error(`Prompt not found: ${name}`);
  const version = `${name}.v${best}`;
  // Git on Windows (core.autocrlf) may check prompts out with CRLF; prompts are always rendered with LF.
  const template = readFileSync(join(PROMPTS_DIR, `${version}.md`), 'utf8').replace(/\r\n/g, '\n');
  const declared = new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
  return {
    version,
    render(vars) {
      const unknown = Object.keys(vars).filter((k) => !declared.has(k));
      if (unknown.length) throw new Error(`Prompt ${version}: unknown vars: ${unknown.join(', ')}`);
      const missing = [...declared].filter((k) => !(k in vars));
      if (missing.length) throw new Error(`Prompt ${version}: unfilled vars: ${missing.join(', ')}`);
      return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k]!);
    },
  };
}
