import { GLOSSARY, type GlossaryTerm } from '@/lib/glossary';

/**
 * A small "?" that opens a plain-language explanation. Native details/summary, so it works without JS; the panel sits
 * in the flow (no popover) so it never causes sideways scroll.
 */
export function HelpTip({ term }: { term: GlossaryTerm }) {
  const { label, text } = GLOSSARY[term];
  return (
    <details className="help-tip">
      <summary aria-label={`What is ${label}?`}>?</summary>
      <p>{text}</p>
    </details>
  );
}
