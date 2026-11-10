import type { RunListRow } from '@bcg/core/dashboard/runs';
import Link from 'next/link';
import { requeueRunAction } from '@/actions/runs';
import { HelpTip } from './help-tip';
import { IdeaRating } from './idea-rating';
import { KeepOpenDetails } from './keep-open-details';
import { runCost, seedSummary } from '@/lib/run-format';
import { runsHref } from '@/lib/runs-query';
import { runStageLabel } from '@/lib/stages';
import { formatDateTime } from '@/lib/time';

const ERROR_SHOWN = 200;
const STATUS_BADGE: Record<string, string> = { queued: 'badge-info', running: 'badge-info', succeeded: 'badge-ok', failed: 'badge-bad' };

const IDEA_OUTCOME: Record<string, string> = { gated_out: 'gate killed', screened_out: 'not shortlisted', duplicate: 'duplicate' };

const cut = (s: string) => (s.length > ERROR_SHOWN ? `${s.slice(0, ERROR_SHOWN)}…` : s);

/** Run history (newest first): created, seed, status, stage, cost, cases, error, stage rows, and Resume on failed runs. */
export function RunsHistory({ rows, total, page, pageSize }: { rows: RunListRow[]; total: number; page: number; pageSize: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <section aria-labelledby="history-title" data-tour="runs-history">
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
                <th scope="col">Ideas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} id={`run-${r.id}`}>
                  <td data-label="Created">{formatDateTime(r.createdAt)}</td>
                  <td data-label="Seed" className="pre">
                    {seedSummary(r.config)}
                    {r.passLabel ? ` · ${r.passLabel}` : ''}
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
                  <td data-label="Cases">
                    {r.cases.length === 0 ? (
                      'none'
                    ) : (
                      <ul className="plain">
                        {r.cases.map((c) => (
                          <li key={c.id}>
                            <Link href={`/cases/${c.slug}`}>{c.title}</Link>
                          </li>
                        ))}
                        {r.caseCount > r.cases.length ? <li className="muted small">and {r.caseCount - r.cases.length} more</li> : null}
                      </ul>
                    )}
                  </td>
                  <td data-label="Error" className="pre">
                    {r.error ? cut(r.error) : ''}
                  </td>
                  <td data-label="Stages">
                    <details>
                      <summary>{r.stages.length} stages</summary>
                      <ul className="plain">
                        {r.stages.map((s) => (
                          <li key={s.stage}>
                            {runStageLabel(s.stage)}: {s.status} · {formatDateTime(s.startedAt)} → {formatDateTime(s.finishedAt)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                  <td data-label="Ideas">
                    {/* Stays open across rating submits (each one refreshes the page). */}
                    <KeepOpenDetails storageKey={`run-ideas.${r.id}`} summary={`${r.ideas.length} ideas`}>
                      <HelpTip term="rateIdeas" />
                      <ul className="plain">
                        {r.ideas.map((i) => (
                          <li key={i.id}>
                            <strong>{i.title}</strong>{' '}
                            <span className="badge badge-muted" data-testid="idea-outcome">
                              {i.caseSlug ? <Link href={`/cases/${i.caseSlug}`}>case</Link> : (IDEA_OUTCOME[i.status] ?? i.status)}
                            </span>{' '}
                            <span className="muted small">{i.oneLiner}</span>
                            {i.origin === 'generated' ? <IdeaRating idea={i} /> : null}
                          </li>
                        ))}
                      </ul>
                    </KeepOpenDetails>
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
