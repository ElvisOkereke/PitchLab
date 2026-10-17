// Invisible / bidi / formatting characters that can hide or reorder text, plus the Unicode tag block.
// Global flag: use only with String.replace (RegExp.test with /g is stateful); isInvisibleChar tests one character.
export const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180E\u3164\uFFA0\u{1D173}-\u{1D17A}\p{Cc}]/gu;
const INVISIBLE_ONE = new RegExp(`^${INVISIBLE.source}$`, 'u');
const KEEP = new Set([0x09, 0x0a]);

/** True for a character in the invisible/control set other than tab and newline. */
export function isInvisibleChar(c: string): boolean {
  return INVISIBLE_ONE.test(c) && !KEEP.has(c.codePointAt(0)!);
}

/** Remove invisible, bidi, formatting and control characters (tab and newline are kept). */
export function stripInvisible(content: string): string {
  return content.replace(INVISIBLE, (c) => (KEEP.has(c.codePointAt(0)!) ? c : ''));
}

/** Neutralise untrusted text: every angle bracket becomes a look-alike, invisible/control formatting chars are removed. */
export function neutralizeUntrusted(content: string): string {
  return stripInvisible(content).replace(/</g, '‹').replace(/>/g, '›');
}

/** Wrap untrusted text in `<tag>…</tag>`; nothing inside it can form or close a tag. */
export function wrapUntrusted(tag: string, content: string): string {
  return `<${tag}>\n${neutralizeUntrusted(content)}\n</${tag}>`;
}

/** Collapse whitespace/control chars to single spaces, trim, and cut to `max` chars. */
export function capField(s: string | null | undefined, max: number): string {
  return (s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
