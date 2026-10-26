import { cell, line } from '../case/export-markdown';
import { METRIC_DEFS } from './definitions';
import type { PassRow } from './passes';

export const SMALL_SAMPLE_NOTE = 'Small sample: differences under about 0.05 similarity or one case may be noise.';

/** A Markdown scorecard: one row per metric, one column per pass. All text is escaped (R13). */
export function renderScorecardMarkdown(passes: PassRow[]): string {
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
  }
  out.push('', SMALL_SAMPLE_NOTE, '');
  return out.join('\n');
}
