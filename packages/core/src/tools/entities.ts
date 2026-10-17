import { isInvisibleChar } from '../llm/untrusted';

const NAMED: Record<string, string> = {
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY = /&(?:#(\d{1,10})|#[xX]([0-9a-fA-F]{1,8})|([a-zA-Z]+));/g;

/**
 * A code point that decodes to a real, visible character: within Unicode, not a surrogate, and not in the
 * invisible/control set (C0/C1 controls other than tab and newline, \p{Cf} format chars such as U+200B and U+202E,
 * and other invisible fillers). Anything else stays as the literal entity text.
 */
const validCodePoint = (cp: number) =>
  Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && !isInvisibleChar(String.fromCodePoint(cp));

/**
 * Decode HTML entities in one pass: every numeric entity (`&#8217;`, `&#x2019;`) and a small named set (curly quotes,
 * ellipsis, dashes, nbsp, `&amp; &lt; &gt; &quot; &apos;`). One pass means `&amp;lt;` becomes `&lt;`, never `<`.
 * Invalid code points and unknown names stay literal. The output is plain text: callers that render or store it must
 * still neutralise `<`/`>` (cleanText strips tags; the Markdown export escapes, R13).
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    return validCodePoint(cp) ? String.fromCodePoint(cp) : m;
  });
}
