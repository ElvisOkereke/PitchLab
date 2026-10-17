// Invisible / bidi / formatting characters that can hide or reorder text, plus the Unicode tag block.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

/** Neutralise untrusted text: every angle bracket becomes a look-alike, invisible/control formatting chars are removed. */
export function neutralizeUntrusted(content: string): string {
  return content.replace(INVISIBLE, '').replace(/</g, '‹').replace(/>/g, '›');
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
