// Read-only: print stored fields of ideas whose title/one-liner/problem/solution match any search term.
// Usage (from packages/core, no other process holding the PGlite DB):
//   npx tsx scripts/find-ideas.ts <term> [term...]
// Always opens the repo-root DB (.data/pglite), resolved from this file's location, not cwd.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { ideas } from '../src/db/schema';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const db = await createDb(`pglite://${resolve(repoRoot, '.data/pglite')}`);
const terms = process.argv.slice(2).map((t) => t.toLowerCase());
const rows = await db.select({
  id: ideas.id, runId: ideas.runId, title: ideas.title, oneLiner: ideas.oneLiner, buyer: ideas.buyer,
  problem: ideas.problem, solution: ideas.solution, mechanism: ideas.mechanism, buyerType: ideas.buyerType,
  status: ideas.status, origin: ideas.origin, createdAt: ideas.createdAt,
}).from(ideas).orderBy(desc(ideas.createdAt));
for (const r of rows) {
  const hay = `${r.title} ${r.oneLiner}`.toLowerCase();
  if (terms.length && !terms.some((t) => hay.includes(t))) continue;
  console.log(JSON.stringify(r, null, 2));
}
process.exit(0);
