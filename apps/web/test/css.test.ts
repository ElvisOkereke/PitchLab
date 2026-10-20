import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const m = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[2]!;
}

describe('globals.css (D2-R5 item 8)', () => {
  it('does not hide horizontal overflow on the page; containment is done per element', () => {
    expect(css).not.toMatch(/overflow-x:\s*hidden/);
    expect(rule('.card')).toMatch(/min-width:\s*0/);
    expect(rule('.card')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.scroll-x')).toMatch(/overflow-x:\s*auto/);
  });

  it('has a complete visually-hidden utility', () => {
    const vh = rule('.visually-hidden');
    for (const decl of [/position:\s*absolute/, /width:\s*1px/, /height:\s*1px/, /margin:\s*-1px/, /padding:\s*0/, /border:\s*0/, /overflow:\s*hidden/, /clip:\s*rect\(0 0 0 0\)/, /white-space:\s*nowrap/]) {
      expect(vh).toMatch(decl);
    }
  });
});
