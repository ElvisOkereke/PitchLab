// Backtest (gen audit backtest): how often the scale rule (revenue ceiling at the line, and upside of at least 3) agrees
// with the owner's keep or kill on cases they have decided. Read-only; the estimator never saw those decisions.
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cases, ideas } from '../db/schema';
import { DEFAULT_MIN_REVENUE_CEILING, ValueToUserSchema, currentScale, upsideScore } from '../pipeline/business-models';

/** The default kill line, shared with the gate (business-models); re-exported for existing imports. */
export { DEFAULT_MIN_REVENUE_CEILING };
/** The rule keeps an idea only when its upside (value kind) is at least this. */
export const MIN_UPSIDE = 3;
const MD_CELL_MAX = 120;

export type BacktestRow = { title: string; stage: string; revenueCeiling: number; upside: number };
export type Backtest = {
  /** Decided cases with a revenue ceiling: the ones compared. */
  decided: number;
  agree: number;
  table: { keptAbove: number; keptBelow: number; killedAbove: number; killedBelow: number };
  disagreements: BacktestRow[];
  /** Decided cases with no scale result or an unknown ceiling; left out of the agreement. */
  noEstimate: { title: string; stage: string }[];
};

export async function runBacktest(db: Db, opts: { minRevenueCeiling: number }): Promise<Backtest> {
  const rows = await db.select({
    title: ideas.title, stage: cases.stage, scaleEstimate: ideas.scaleEstimate, scaleResult: ideas.scaleResult,
    priceHint: ideas.priceHint, businessModel: ideas.businessModel, valueToUser: ideas.valueToUser,
  })
    .from(cases).innerJoin(ideas, eq(ideas.id, cases.ideaId))
    .where(and(ne(cases.stage, 'new'), eq(cases.isExample, false)))
    .orderBy(asc(cases.createdAt), asc(cases.id)).limit(2000);
  const bt: Backtest = { decided: 0, agree: 0, table: { keptAbove: 0, keptBelow: 0, killedAbove: 0, killedBelow: 0 }, disagreements: [], noEstimate: [] };
  for (const r of rows) {
    // The ceiling the gate would judge now (currentScale: recomputed from the estimate when it is valid).
    const ceiling = currentScale(r)?.revenueCeiling ?? null;
    if (ceiling === null) { bt.noEstimate.push({ title: r.title, stage: r.stage }); continue; }
    const value = ValueToUserSchema.safeParse(r.valueToUser);
    const upside = upsideScore(value.success ? value.data.kind : null);
    const above = ceiling >= opts.minRevenueCeiling;
    const kept = r.stage !== 'killed';
    bt.decided += 1;
    bt.table[`${kept ? 'kept' : 'killed'}${above ? 'Above' : 'Below'}`] += 1;
    const ruleKeeps = above && upside >= MIN_UPSIDE;
    if (ruleKeeps === kept) bt.agree += 1;
    else bt.disagreements.push({ title: r.title, stage: r.stage, revenueCeiling: ceiling, upside });
  }
  return bt;
}

const cell = (s: string) => s.replace(/[|\r\n]+/g, ' ').slice(0, MD_CELL_MAX);
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
export const agreementPct = (bt: Backtest) => (bt.decided === 0 ? 0 : Math.round((bt.agree / bt.decided) * 100));

export function renderBacktestMarkdown(bt: Backtest, o: { minRevenueCeiling: number; date: string }): string {
  const t = bt.table;
  const lines = [
    `# Scale backtest, ${o.date}`,
    '',
    `The rule keeps an idea when its revenue ceiling is at least ${money(o.minRevenueCeiling)} and its upside is at least ${MIN_UPSIDE} (earn 5, time 3, risk 3, save 2, unknown 3). It is compared with the cases you kept (validating, pilot or live) or killed.`,
    '',
    `Agreement: ${agreementPct(bt)}% (${bt.agree} of ${bt.decided} decided cases with an estimate).`,
    '',
    `| | At or above the line | Below the line |`,
    `|---|---|---|`,
    `| Kept | ${t.keptAbove} | ${t.keptBelow} |`,
    `| Killed | ${t.killedAbove} | ${t.killedBelow} |`,
    '',
    `## Where the rule and you disagree (${bt.disagreements.length})`,
    '',
  ];
  if (bt.disagreements.length === 0) lines.push('None.');
  else {
    lines.push('| Idea | You | Revenue ceiling | Upside |', '|---|---|---|---|');
    for (const d of bt.disagreements) lines.push(`| ${cell(d.title)} | ${d.stage === 'killed' ? 'killed' : 'kept'} | ${money(d.revenueCeiling)} | ${d.upside} |`);
  }
  lines.push('', `## No estimate (${bt.noEstimate.length})`, '', 'These cases have no scale result or no known revenue ceiling, so they are left out of the agreement.', '');
  if (bt.noEstimate.length === 0) lines.push('None.');
  else for (const d of bt.noEstimate) lines.push(`- ${cell(d.title)} (${d.stage === 'killed' ? 'killed' : 'kept'})`);
  return lines.join('\n') + '\n';
}
