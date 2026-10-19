import { z } from 'zod';
import type { ideas } from '../db/schema';
import { capField } from '../llm/untrusted';

type IdeaFields = Pick<typeof ideas.$inferSelect, 'title' | 'oneLiner' | 'buyer' | 'problem' | 'solution'> &
  Partial<Pick<typeof ideas.$inferSelect, 'knownIncumbents' | 'functionalGap'>>;

const MAX_INCUMBENTS = 8;
const CLAIM = "(the idea's own unverified claim)";
const incumbentList = z.array(z.string());

/**
 * Incumbent names from the jsonb column, ready for one prompt line: anything but an array of strings is treated as
 * absent; `;` becomes `,` (the list separator stays unambiguous), newlines and control chars collapse, each name is
 * capped at 120, empties are dropped, at most 8 are kept.
 */
function incumbentNames(raw: unknown): string[] {
  const parsed = incumbentList.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((n) => capField(n.replace(/;/g, ','), 120)).filter(Boolean).slice(0, MAX_INCUMBENTS);
}

/**
 * An idea as prompt text: one line per field, each capped (title 200, others 2000) with newlines collapsed. Ideas from
 * ideate.v7 also get the incumbents (joined with "; ") and the functional gap (capped at 600), each labelled as the
 * idea's own unverified claim; a line is omitted when its value is null, empty or invalid (owner and older ideas), never
 * synthesised. Feeds screen, gate and deep-case. Wrap before use.
 */
export function ideaBlock(idea: IdeaFields): string {
  const lines = [
    `Title: ${capField(idea.title, 200)}`,
    `One-liner: ${capField(idea.oneLiner, 2000)}`,
    `Buyer: ${capField(idea.buyer, 2000)}`,
    `Problem: ${capField(idea.problem, 2000)}`,
    `Solution: ${capField(idea.solution, 2000)}`,
  ];
  const names = incumbentNames(idea.knownIncumbents);
  if (names.length) lines.push(`Known incumbents ${CLAIM}: ${names.join('; ')}`);
  const gap = typeof idea.functionalGap === 'string' ? capField(idea.functionalGap, 600) : '';
  if (gap) lines.push(`Functional gap ${CLAIM}: ${gap}`);
  return lines.join('\n');
}
