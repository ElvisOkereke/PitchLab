import type { ideas } from '../db/schema';
import { capField } from '../llm/untrusted';

type IdeaFields = Pick<typeof ideas.$inferSelect, 'title' | 'oneLiner' | 'buyer' | 'problem' | 'solution'>;

/** An idea as prompt text: one line per field, each capped (title 200, others 2000) with newlines collapsed. Wrap before use. */
export function ideaBlock(idea: IdeaFields): string {
  return (
    `Title: ${capField(idea.title, 200)}\nOne-liner: ${capField(idea.oneLiner, 2000)}\nBuyer: ${capField(idea.buyer, 2000)}\n` +
    `Problem: ${capField(idea.problem, 2000)}\nSolution: ${capField(idea.solution, 2000)}`
  );
}
