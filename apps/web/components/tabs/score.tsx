import { CRITERIA } from '@bcg/core/case/schema';
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { CRITERION_LABEL, OWNER_CRITERIA, scoreSummary } from '@bcg/core/dashboard/criteria';
import { formatScore } from '@/lib/stages';
import { HelpTip } from '../help-tip';
import { ScoreForm } from '../score-form';

/** AI scores (read-only) and the owner's score form (7 criteria + "Your gut"), pre-filled with his latest values. */
export function ScoreTab({ view }: { view: CaseView }) {
  const summary = scoreSummary(view.scores);
  const aiRows = CRITERIA.flatMap((c) => {
    const e = summary.latest[c]?.ai;
    return e ? [{ criterion: c, label: CRITERION_LABEL[c], ...e }] : [];
  });
  const rows = OWNER_CRITERIA.map((c) => {
    const e = summary.latest[c]?.owner;
    return { criterion: c, label: CRITERION_LABEL[c], value: e?.value ?? null, note: e?.note ?? '' };
  });
  return (
    <div className="tab tab-score">
      <h2>
        AI scores <HelpTip term="aiScore" />
      </h2>
      <p>
        AI mean: {formatScore(summary.ai)} · Your mean: {formatScore(summary.owner)}
      </p>
      <div className="scroll-x" data-testid="ai-scores">
        {aiRows.length === 0 ? (
          <p className="muted">Not scored yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Score</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {aiRows.map((r) => (
                <tr key={r.criterion}>
                  <th scope="row">{r.label}</th>
                  <td>{r.value}</td>
                  <td className="pre">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Your scores</h2>
      <ScoreForm caseId={view.case.id} slug={view.case.slug} rows={rows} />
    </div>
  );
}
