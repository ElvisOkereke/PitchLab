/** Wrap untrusted text in `<tag>…</tag>`; any `<tag` / `</tag` inside it is neutralised so it cannot close the block. */
export function wrapUntrusted(tag: string, content: string): string {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safe = content.replace(new RegExp(`<(/?${esc})`, 'gi'), '‹$1');
  return `<${tag}>\n${safe}\n</${tag}>`;
}
