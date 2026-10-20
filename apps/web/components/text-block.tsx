/** Multi-line case text: line breaks kept (pre-wrap), long words wrap, rendered as a text node. */
export function TextBlock({ text }: { text: string }) {
  return <p className="pre">{text}</p>;
}
