import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every relative Markdown link in the user-facing docs must point at a file that exists, so the docs cannot rot
// silently when files move. External (http/https/mailto) links and same-page #anchors are not checked.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS = ['README.md', 'docs/user-guide.md', 'docs/architecture.md', 'docs/glossary.md', 'docs/dashboard.md'];

/** Link targets of `[text](target)` and `![alt](target)`, outside fenced code blocks and inline code. */
function linkTargets(markdown: string): string[] {
  const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
  const targets: string[] = [];
  for (const m of prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)) targets.push((m[1] ?? m[2])!);
  return targets;
}

const isExternal = (t: string) => /^(https?:|mailto:)/i.test(t);

describe('linkTargets', () => {
  it('finds links and images, skips code', () => {
    const md = '[a](docs/x.md) ![i](img.png "t")\n`[no](skip.md)`\n```\n[no](fenced.md)\n```\n[b](<y z.md#top>)';
    expect(linkTargets(md)).toEqual(['docs/x.md', 'img.png', 'y z.md#top']);
  });
});

describe('docs links', () => {
  for (const doc of DOCS) {
    it(`${doc} exists and its relative links resolve`, () => {
      const path = join(ROOT, doc);
      expect(existsSync(path), `${doc} is missing`).toBe(true);
      const broken = linkTargets(readFileSync(path, 'utf8'))
        .filter((t) => !isExternal(t) && !t.startsWith('#'))
        .filter((t) => {
          const file = decodeURIComponent(t.split('#')[0]!.split('?')[0]!);
          return !existsSync(join(dirname(path), file));
        });
      expect(broken, `${doc} has broken links`).toEqual([]);
    });
  }
});
