import type { ideas } from '../db/schema';
import { capField } from '../llm/untrusted';

type IdeaFields = Pick<typeof ideas.$inferSelect, 'title' | 'oneLiner' | 'buyer' | 'problem' | 'solution'> &
  Partial<Pick<typeof ideas.$inferSelect, 'knownIncumbents' | 'functionalGap'>>;

/**
 * An idea as prompt text: one line per field, each capped (title 200, others 2000) with newlines collapsed. Ideas from
 * ideate.v7 also get `Known incumbents:` (each name capped at 120, joined with "; ") and `Functional gap:` (capped at
 * 600); a null field (owner and older ideas) omits its line. Feeds screen, gate and deep-case. Wrap before use.
 */
export function ideaBlock(idea: IdeaFields): string {
  const lines = [
    `Title: ${capField(idea.title, 200)}`,
    `One-liner: ${capField(idea.oneLiner, 2000)}`,
    `Buyer: ${capField(idea.buyer, 2000)}`,
    `Problem: ${capField(idea.problem, 2000)}`,
    `Solution: ${capField(idea.solution, 2000)}`,
  ];
  // jsonb column: only a list of strings is rendered.
  if (Array.isArray(idea.knownIncumbents)) {
    const names = idea.knownIncumbents.map((n) => capField(String(n), 120)).filter(Boolean);
    lines.push(`Known incumbents: ${names.length ? names.join('; ') : '(none known)'}`);
  }
  if (idea.functionalGap != null) lines.push(`Functional gap: ${capField(idea.functionalGap, 600)}`);
  return lines.join('\n');
}
