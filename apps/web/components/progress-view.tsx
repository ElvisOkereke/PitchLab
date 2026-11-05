import { METRIC_DEFS } from '@bcg/core/bench/definitions';
import type { PassRow } from '@bcg/core/bench/passes';
import type { MetricResult } from '@bcg/core/bench/scorecard';
import Link from 'next/link';
import type { PassAuditView } from '@/lib/audit-query';
import { progressColumns } from '@/lib/progress-columns';
import { HelpTip } from './help-tip';
import { PassAuditSection } from './pass-audit-view';
import { RecomputeForm } from './recompute-form';
import { RunBenchmarkForm } from './run-benchmark-form';

const METRIC_HELP: Partial<Record<(typeof METRIC_DEFS)[number]['id'], 'ownerLikes' | 'nicheShare'>> = { ownerLikes: 'ownerLikes', nicheShare: 'nicheShare' };

export type RunningPass = { label: string; done: number; total: number };
export type ScoreCases = { label: string; cases: { slug: string; title: string; gut: number | null }[] };

const day = (d: Date) => d.toISOString().slice(0, 10);

function Cell({ m }: { m: MetricResult | undefined }) {
  if (!m || m.status !== 'measured') {
    return (
      <td className="muted">
        {m?.display ?? 'no data'}
        {m?.note ? <div className="small">{m.note}</div> : null}
      </td>
    );
  }
  return (
    <td>
      {m.display}{' '}
      {m.meets === null ? null : (
        <span className={`badge ${m.meets ? 'badge-ok' : 'badge-bad'}`}>{m.meets ? 'meets target' : 'misses target'}</span>
      )}
    </td>
  );
}

/** The scorecard (oldest baseline, the canonical one, plus the 5 newest passes), the run state, and the cases to score. Props only; no data access. */
export function ProgressView({
  passes,
  running,
  scoreCases,
  costNote,
  runCount,
  audits = {},
}: {
  passes: PassRow[];
  running: RunningPass | null;
  scoreCases: ScoreCases | null;
  costNote: string;
  runCount: number;
  /** Each shown pass's audit, by pass id (loaded by the page; this view reads no data). */
  audits?: Record<string, PassAuditView>;
}) {
  const columns = progressColumns(passes);
  const baseline = columns.find((p) => p.kind === 'baseline') ?? null;
  return (
    <>
      {baseline ? null : <p className="notice card">No baseline yet. Run: npm run gen -- bench baseline</p>}
      {running ? (
        <p className="card" role="status">
          {running.label} running: {running.done} of {running.total} runs finished. <Link href="/runs">See the runs</Link>
          <span className="muted small"> · this page refreshes every 10 s</span>
        </p>
      ) : (
        <section aria-labelledby="bench-run-title" className="card">
          <h2 id="bench-run-title">Run benchmark</h2>
          <RunBenchmarkForm costNote={costNote} runCount={runCount} />
        </section>
      )}
      <div className="scroll-x" data-tour="progress-scorecard">
        <table>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {columns.map((p) => (
                <th key={p.id} scope="col">
                  {p.label}
                  <div className="muted small">{day(p.createdAt)}</div>
                  <div className="muted small">Id {p.id.slice(0, 8)}</div>
                  {p.status === 'incomplete' ? <span className="badge badge-warn">incomplete</span> : null}
                  <RecomputeForm passId={p.id} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRIC_DEFS.map((d) => (
              <tr key={d.id} data-metric={d.id}>
                <th scope="row">
                  {d.label}
                  {METRIC_HELP[d.id] ? <HelpTip term={METRIC_HELP[d.id]!} /> : null}
                  <div className="muted small">Target: {d.target}</div>
                </th>
                {columns.length === 0 ? <td className="muted">no data</td> : null}
                {columns.map((p) => (
                  <Cell key={p.id} m={p.metrics?.metrics.find((x) => x.id === d.id)} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {columns.some((p) => (p.metrics?.notes.length ?? 0) > 0) ? (
        <section aria-label="Notes on each column" className="small">
          {columns
            .filter((p) => (p.metrics?.notes.length ?? 0) > 0)
            .map((p) => (
              <div key={p.id}>
                <strong>{p.label}</strong>
                <ul>
                  {p.metrics!.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ) : null}
      {columns.filter((p) => audits[p.id]).map((p) => (
        <PassAuditSection key={p.id} label={p.label} view={audits[p.id]!} />
      ))}
      <p className="muted small">Small sample: differences under about 0.05 similarity or one case may be noise.</p>
      {scoreCases ? (
        <section aria-labelledby="bench-score-title" className="card">
          <h2 id="bench-score-title">Score these cases</h2>
          <p className="muted small">From {scoreCases.label}. Press Recompute under its column to include your gut scores in the owner verdict.</p>
          {scoreCases.cases.length === 0 ? (
            <p className="muted">This pass made no cases.</p>
          ) : (
            <ul>
              {scoreCases.cases.map((c) => (
                <li key={c.slug}>
                  <Link href={`/cases/${c.slug}?tab=score`}>{c.title}</Link>{' '}
                  <span className="muted">{c.gut === null ? 'not scored' : `Your gut: ${c.gut}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}
