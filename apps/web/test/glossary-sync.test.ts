import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '@/lib/glossary';

const doc = readFileSync(fileURLToPath(new URL('../../../docs/glossary.md', import.meta.url)), 'utf8');
const headings = doc.split(/\r?\n/).filter((l) => l.startsWith('### '));

describe('docs/glossary.md', () => {
  it('has a heading for every in-app glossary entry', () => {
    for (const { label } of Object.values(GLOSSARY)) expect(headings).toContain(`### ${label}`);
  });

  it('covers the pipeline and validation terms', () => {
    const terms = ['harvest', 'signal', 'voice', 'ideate', 'dedupe', 'screen', 'gate', 'case', 'claim', 'verify', 'score', 'validation pack', 'prospect', 'draft', 'landing page', 'run', 'notional spend'];
    const lower = headings.map((h) => h.toLowerCase());
    for (const t of terms) expect(lower).toContain(`### ${t}`);
  });
});
