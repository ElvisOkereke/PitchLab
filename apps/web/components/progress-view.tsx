import { METRIC_DEFS } from '@bcg/core/bench/definitions';
import type { PassRow } from '@bcg/core/bench/passes';
import type { MetricResult } from '@bcg/core/bench/scorecard';
import Link from 'next/link';
import { RunBenchmarkForm } from './run-benchmark-form';

const MAX_PASS_COLUMNS = 5;

export type RunningPass = { label: string; done: number; total: number };
export type ScoreCases = { label: string; cases: { slug: string; title: string; gut: number | null }[] };

const day = (d: Date) => d.toISOString().slice(0, 10);

function Cell({ m }: { m: MetricResult | undefined }) {
  if (!m || m.status !== 'measured') return <td className="muted">{m?.display ?? 'no data'}</td>;
  return (
    <td>
      {m.display}{' '}
      {m.meets === null ? null : (
        <span className={`badge ${m.meets ? 'badge-ok' : 'badge-bad'}`}>{m.meets ? 'meets target' : 'misses target'}</span>
      )}
    </td>
  );
}

/** The scorecard (newest baseline plus the 5 newest passes), the run state, and the cases to score. Props only; no data access. */
export function ProgressView({
  passes,
  running,
  scoreCases,
  costNote,
}: {
  passes: PassRow[];
  running: RunningPass | null;
  scoreCases: ScoreCases | null;
  costNote: string;
}) {
  const baseline = passes.find((p) => p.kind === 'baseline') ?? null;
  const recent = passes.filter((p) => p.kind !== 'baseline' && p.status !== 'running').slice(0, MAX_PASS_COLUMNS).reverse();
  const columns = baseline ? [baseline, ...recent] : recent;
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
          <RunBenchmarkForm costNote={costNote} />
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
                  {p.status === 'incomplete' ? <span className="badge badge-warn">incomplete</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRIC_DEFS.map((d) => (
              <tr key={d.id} data-metric={d.id}>
                <th scope="row">
                  {d.label}
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
      <p className="muted small">Small sample: differences under about 0.05 similarity or one case may be noise.</p>
      {scoreCases ? (
        <section aria-labelledby="bench-score-title" className="card">
          <h2 id="bench-score-title">Score these cases</h2>
          <p className="muted small">From {scoreCases.label}. Your gut score feeds the owner verdict.</p>
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
