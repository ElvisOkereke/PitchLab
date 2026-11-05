import { cell, line } from '../case/export-markdown';
import type { HoldoutResult } from '../audit/holdout';
import type { PassAudit } from '../audit/pass-audit';
import { METRIC_DEFS } from './definitions';
import type { PassRow } from './passes';

export const SMALL_SAMPLE_NOTE = 'Small sample: differences under about 0.05 similarity or one case may be noise.';

/** What the report shows under a pass besides its metrics: the audit, and the holdout comparison when one was made. */
export type AuditView = { audit: PassAudit; holdoutItems: number; holdout: HoldoutResult | null };

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const counts = (m: Record<string, number>, order?: string[]) => {
  const keys = Object.keys(m).sort((a, b) => (m[b]! - m[a]!) || a.localeCompare(b));
  return (order ?? keys).filter((k) => m[k] !== undefined).map((k) => `${line(k)} ${m[k]}`).join(', ');
};

/** The audit lines for one pass; every figure that cannot be measured reads "no data". */
export function renderAuditLines(v: AuditView): string[] {
  const a = v.audit;
  const s = a.signals;
  const out: string[] = ['', '### Audit', ''];
  out.push(`- Evidence: ${s.total === 0 ? 'no data' : `${s.total} signals`}`);
  if (s.total > 0) {
    out.push(`- Voices: ${counts(s.byVoice)}`, `- Sources: ${counts(s.bySource)}`,
      `- Top domains: ${s.topDomains.map((d) => `${line(d.domain)} ${pct(d.share)}`).join(', ')}`);
  }
  out.push(a.lenses.length === 0 ? '- Lens yield: no data' : '- Lens yield:');
  for (const l of a.lenses) out.push(`  - ${line(l.lensId)}: ${l.ideas} ideas, ${l.screenedIn} reached the gate, ${l.advanced} advanced, ${l.cases} cases`);
  out.push(`- Gate kills by check: ${Object.keys(a.gateKills).length === 0 ? 'no data' : counts(a.gateKills)}`,
    `- Ideas dropped by ideate: ${Object.keys(a.dropReasons).length === 0 ? 'none recorded' : counts(a.dropReasons)}`,
    `- Ideas resting on a trend, rule change or market: ${a.demandShare === null ? 'no data' : pct(a.demandShare)}`,
    `- Niche share (idea reviewer): ${a.nicheShare === null ? 'no data' : pct(a.nicheShare)}`);
  out.push(a.flags.length === 0 ? '- Audit flags: none' : '- Audit flags:');
  for (const f of a.flags) out.push(`  - ${line(f)}`);
  if (v.holdoutItems === 0) {
    out.push('- Holdout examples: none set (npm run gen -- audit holdout add "...")');
  } else if (!v.holdout || v.holdout.items.length === 0) {
    out.push(`- Holdout examples: ${v.holdoutItems} set, no comparison for this pass`);
  } else {
    out.push(`- Holdout examples: median similarity ${v.holdout.median === null ? 'no data' : v.holdout.median.toFixed(2)}`);
    for (const i of v.holdout.items) out.push(`  - ${line(i.text.slice(0, 80))}: closest idea ${line(i.bestIdeaTitle)} (${i.similarity.toFixed(2)})`);
  }
  return out;
}

/** A Markdown scorecard: one row per metric, one column per pass, plus each pass's audit when given. All text is escaped (R13). */
export function renderScorecardMarkdown(passes: PassRow[], audits: Record<string, AuditView> = {}): string {
  const out: string[] = ['# PitchLab idea-quality scorecard', ''];
  const head = ['Metric', 'Target', ...passes.map((p) => cell(p.label))];
  out.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
  for (const d of METRIC_DEFS) {
    const cols = passes.map((p) => {
      const m = p.metrics?.metrics.find((x) => x.id === d.id);
      if (!m) return 'no data';
      return cell(m.display) + (m.meets === true ? ' ✓' : m.meets === false ? ' ✗' : '');
    });
    out.push(`| ${[cell(d.label), cell(d.target), ...cols].join(' | ')} |`);
  }
  for (const p of passes) {
    const m = p.metrics;
    out.push('', `## ${line(p.label)}`, '', `Id: ${p.id}`, `Status: ${p.status}`);
    if (!m) {
      out.push('', 'No figures for this pass yet.');
      continue;
    }
    const e = m.extra;
    out.push('', `- Runs: ${e.runs}`, `- Ideas: ${e.ideas}`, `- Cases: ${e.cases} (${e.scoredCases} scored by you)`,
      `- Median return: ${e.medianRoi === null ? 'no data' : `${e.medianRoi.toFixed(2)}×`}`,
      `- New versus history: ${e.newVsHistory === null ? 'no data' : e.newVsHistory.toFixed(2)}`);
    const notes = [...m.notes, ...m.metrics.flatMap((x) => (x.note ? [`${METRIC_DEFS.find((d) => d.id === x.id)?.label ?? x.id}: ${x.note}`] : []))];
    if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `- ${line(n)}`));
    const view = audits[p.id];
    if (view) out.push(...renderAuditLines(view));
  }
  out.push('', SMALL_SAMPLE_NOTE, '');
  return out.join('\n');
}
