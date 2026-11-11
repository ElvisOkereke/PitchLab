import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { KEPT_STAGES } from '../bench/scorecard';
import type { Db } from '../db/client';
import { cases, ideas, judgePairs } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import type { ModelRouter } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { scrubPersonal } from '../research/privacy';
import { FEWSHOT_PAIRS_MAX, TRAIN_SHARE } from '../pipeline/engine/kinds';
import type { FewShot, SketchView } from '../pipeline/engine/schema';

/**
 * Judge pairs (spec §5): every kept-versus-killed pair of ideas the owner decided on the Board (case stage) or rated
 * (liked against disliked). Each pair is split once, by its hash, into a training share (few-shot examples for the
 * tournament judge) and a test share (held out; only calibration judges them). Rows are insert-only, so a pair never
 * changes split.
 */

const MAX_IDEAS_PER_SIDE = 2_000;
const INSERT_CHUNK = 500;
const POOL_MAX = 500;
const FIELD_MAX = 300;
const REASON_MAX = 300;
const REASON_MAX_TOKENS = 300;

/** sha256 of the two idea ids, sorted and joined. */
export function pairHashOf(a: string, b: string): string {
  return createHash('sha256').update([a, b].sort().join(':')).digest('hex');
}

/** The split a pair hash gets: the first byte over 255 below TRAIN_SHARE is train. */
export function splitOfHash(hash: string): 'train' | 'test' {
  return parseInt(hash.slice(0, 2), 16) / 255 < TRAIN_SHARE ? 'train' : 'test';
}

/** Idea ids on the kept side (kept case or liked) and the killed side (killed case or disliked); ideas on both sides are left out. */
async function sides(db: Db): Promise<{ kept: string[]; killed: string[] }> {
  const notExample = eq(cases.isExample, false);
  const keptCases = await db.select({ id: cases.ideaId }).from(cases)
    .where(and(inArray(cases.stage, [...KEPT_STAGES]), notExample)).limit(MAX_IDEAS_PER_SIDE);
  const killedCases = await db.select({ id: cases.ideaId }).from(cases)
    .where(and(eq(cases.stage, 'killed'), notExample)).limit(MAX_IDEAS_PER_SIDE);
  const liked = await db.select({ id: ideas.id }).from(ideas).where(gt(ideas.ownerRating, 0)).limit(MAX_IDEAS_PER_SIDE);
  const disliked = await db.select({ id: ideas.id }).from(ideas).where(lt(ideas.ownerRating, 0)).limit(MAX_IDEAS_PER_SIDE);
  const kept = new Set([...keptCases, ...liked].map((r) => r.id));
  const killed = new Set([...killedCases, ...disliked].map((r) => r.id));
  return { kept: [...kept].filter((id) => !killed.has(id)).sort(), killed: [...killed].filter((id) => !kept.has(id)).sort() };
}

/** Adds the pairs not stored yet; existing rows are never touched. */
export async function syncJudgePairs(db: Db): Promise<{ added: number }> {
  const { kept, killed } = await sides(db);
  const rows: (typeof judgePairs.$inferInsert)[] = [];
  for (const k of kept) {
    for (const x of killed) {
      const pairHash = pairHashOf(k, x);
      rows.push({ keptIdeaId: k, killedIdeaId: x, pairHash, split: splitOfHash(pairHash) });
    }
  }
  let added = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const got = await db.insert(judgePairs).values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing({ target: judgePairs.pairHash }).returning({ id: judgePairs.id });
    added += got.length;
  }
  return { added };
}

type IdeaRow = typeof ideas.$inferSelect;

function edgeText(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const e = raw as { claim?: unknown; versus?: unknown };
    if (typeof e.claim === 'string' && e.claim) return typeof e.versus === 'string' && e.versus ? `${e.claim} (today: ${e.versus})` : e.claim;
  }
  return '';
}

/** An idea row as the judge sees a sketch (Ruling R2): no whyNotTrivial for ideas. */
export function ideaView(i: IdeaRow): SketchView {
  return {
    title: i.title,
    buyer: i.buyer,
    problem: i.problem,
    howItEarns: i.revenueMechanics || i.solution,
    edge: edgeText(i.edge) || i.functionalGap || 'none stated',
  };
}

const viewBlock = (tag: string, v: SketchView) => wrapUntrusted(tag, [
  `Title: ${capField(v.title, FIELD_MAX)}`, `Buyer: ${capField(v.buyer, FIELD_MAX)}`, `Problem: ${capField(v.problem, FIELD_MAX)}`,
  `How it earns: ${capField(v.howItEarns, FIELD_MAX)}`, `Edge: ${capField(v.edge, FIELD_MAX)}`,
].join('\n'));

/** What the owner said about the pair: tags on both ideas and the kill reason of the killed case. */
function hintsOf(kept: IdeaRow, killed: IdeaRow, killReason: string | null): string[] {
  const out: string[] = [];
  if (kept.ownerTags?.length) out.push(`Tags on the kept idea: ${kept.ownerTags.join(', ')}`);
  if (killed.ownerTags?.length) out.push(`Tags on the killed idea: ${killed.ownerTags.join(', ')}`);
  if (killReason) out.push(`Owner note when killing it: ${capField(killReason, FIELD_MAX)}`);
  return out;
}

const fallbackReason = (hints: string[]): string => (hints.length ? capField(hints.join('; '), REASON_MAX) : 'the owner preferred it');

/**
 * Few-shot examples for the tournament judge: Board pairs from the training split only, at most `n`. Pairs are taken in
 * hash order, preferring pairs that bring ideas not shown yet. A missing reason is written once through `judge-reason.v1`
 * (from the owner's tags and notes) and stored; without a router, or when that call fails, the pair gets a plain
 * reason made from the owner's tags and notes (not stored, so a later call with a router still fills it). A model reason
 * is privacy-scrubbed before it is stored. `excludeIdeaIds` drops pairs that share an idea with it (calibration passes the
 * ideas of its test pairs, so the judge cannot win by recognising an idea it was shown as an example).
 */
export async function fewShotPairs(
  db: Db,
  n: number = FEWSHOT_PAIRS_MAX,
  router?: ModelRouter,
  opts: { runId?: string | null; excludeIdeaIds?: ReadonlySet<string> } = {},
): Promise<FewShot[]> {
  if (n <= 0) return [];
  const exclude = opts.excludeIdeaIds;
  const pool = (await db.select().from(judgePairs).where(eq(judgePairs.split, 'train')).orderBy(asc(judgePairs.pairHash)).limit(POOL_MAX))
    .filter((p) => !exclude || !(exclude.has(p.keptIdeaId) || exclude.has(p.killedIdeaId)));
  const used = new Set<string>();
  const chosen: typeof pool = [];
  for (const p of pool) {
    if (chosen.length >= n) break;
    if (used.has(p.keptIdeaId) || used.has(p.killedIdeaId)) continue;
    chosen.push(p);
    used.add(p.keptIdeaId);
    used.add(p.killedIdeaId);
  }
  for (const p of pool) {
    if (chosen.length >= n) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  if (chosen.length === 0) return [];

  const ids = [...new Set(chosen.flatMap((p) => [p.keptIdeaId, p.killedIdeaId]))];
  const byId = new Map((await db.select().from(ideas).where(inArray(ideas.id, ids))).map((i) => [i.id, i]));
  const killReasons = new Map((await db.select({ id: cases.ideaId, r: cases.killReason }).from(cases)
    .where(and(inArray(cases.ideaId, ids), eq(cases.stage, 'killed')))).map((c) => [c.id, c.r]));

  const out: FewShot[] = [];
  for (const p of chosen) {
    const kept = byId.get(p.keptIdeaId);
    const killed = byId.get(p.killedIdeaId);
    if (!kept || !killed) continue;
    const keptView = ideaView(kept);
    const killedView = ideaView(killed);
    let reason = p.reason?.trim() ?? '';
    if (!reason) {
      const hints = hintsOf(kept, killed, killReasons.get(killed.id) ?? null);
      if (router) {
        try {
          const prompt = loadPrompt('judge-reason');
          const text = await router.text('review', {
            prompt: prompt.render({
              kept: viewBlock('kept', keptView), killed: viewBlock('killed', killedView),
              hints: wrapUntrusted('owner-hints', hints.length ? hints.join('\n') : '(no tags or notes)'),
            }),
            maxTokens: REASON_MAX_TOKENS,
          }, { runId: opts.runId ?? null, promptVersion: prompt.version });
          reason = capField(scrubPersonal(text), REASON_MAX);
          if (reason) await db.update(judgePairs).set({ reason }).where(and(eq(judgePairs.id, p.id), isNull(judgePairs.reason)));
        } catch {
          reason = '';
        }
      }
      if (!reason) reason = fallbackReason(hints);
    }
    out.push({ kept: keptView, killed: killedView, reason });
  }
  return out;
}
