import type { RunListRow } from '@bcg/core/dashboard/runs';
import Link from 'next/link';
import { requeueRunAction } from '@/actions/runs';
import { runCost, seedSummary } from '@/lib/run-format';
import { runsHref } from '@/lib/runs-query';
import { formatDateTime } from '@/lib/time';

const ERROR_SHOWN = 200;
const STATUS_BADGE: Record<string, string> = { queued: 'badge-info', running: 'badge-info', succeeded: 'badge-ok', failed: 'badge-bad' };

const cut = (s: string) => (s.length > ERROR_SHOWN ? `${s.slice(0, ERROR_SHOWN)}…` : s);

/** Run history (newest first): created, seed, status, stage, cost, cases, error, stage rows, and Resume on failed runs. */
export function RunsHistory({ rows, total, page, pageSize }: { rows: RunListRow[]; total: number; page: number; pageSize: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      {rows.length === 0 ? <p className="muted">No runs on this page.</p> : null}
      {rows.length > 0 ? (
        <div className="scroll-x">
          <table className="stacked" data-testid="runs">
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Seed</th>
                <th scope="col">Status</th>
                <th scope="col">Stage</th>
                <th scope="col">Cost</th>
                <th scope="col">Cases</th>
                <th scope="col">Error</th>
                <th scope="col">Stages</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Created">{formatDateTime(r.createdAt)}</td>
                  <td data-label="Seed" className="pre">
                    {seedSummary(r.config)}
                  </td>
                  <td data-label="Status">
                    <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge-muted'}`}>{r.status}</span>
                    {r.status === 'failed' ? (
                      <form action={requeueRunAction} className="inline-form">
                        <input type="hidden" name="runId" value={r.id} />
                        <input type="hidden" name="page" value={String(page)} />
                        <button type="submit" className="secondary">
                          Resume
                        </button>
                      </form>
                    ) : null}
                  </td>
                  <td data-label="Stage">{r.currentStage ?? '–'}</td>
                  <td data-label="Cost">{runCost(r.costUsd)}</td>
                  <td data-label="Cases">{r.caseCount}</td>
                  <td data-label="Error" className="pre">
                    {r.error ? cut(r.error) : ''}
                  </td>
                  <td data-label="Stages">
                    <details>
                      <summary>{r.stages.length} stages</summary>
                      <ul className="plain">
                        {r.stages.map((s) => (
                          <li key={s.stage}>
                            {s.stage}: {s.status} · {formatDateTime(s.startedAt)} → {formatDateTime(s.finishedAt)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {pages > 1 ? (
        <nav className="pager" aria-label="Run pages" data-testid="runs-pager">
          {page > 1 ? <Link href={runsHref(page - 1)}>← Newer</Link> : null}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={runsHref(page + 1)}>Older →</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
