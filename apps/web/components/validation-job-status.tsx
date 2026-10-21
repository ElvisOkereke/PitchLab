import { STALE_RUNNING_MS, type ValidationJobView } from '@bcg/core/dashboard/validation-jobs';
import { formatDateTime } from '@/lib/time';

/** The latest validation job's state. Everything (steps, error) is rendered as React text. `now` is for tests. */
export function ValidationJobStatus({ job, now = new Date() }: { job: ValidationJobView; now?: Date }) {
  const stale = job.status === 'running' && job.startedAt !== null && now.getTime() - job.startedAt.getTime() > STALE_RUNNING_MS;
  return (
    <div className="card" data-tour="validate-status" data-testid="validation-status" role="status">
      {job.status === 'queued' ? <p>Waiting for the worker</p> : null}
      {job.status === 'running' ? (
        <>
          <p>Running since {job.startedAt ? formatDateTime(job.startedAt) : 'just now'}</p>
          {stale ? <p className="muted small">If the worker stopped, start it again and press Run validation again.</p> : null}
        </>
      ) : null}
      {job.status === 'succeeded' ? (
        <>
          <p>Finished</p>
          <ul className="plain">
            {(job.steps ?? []).map((s, i) => (
              <li key={i}>{`${s.step} · ${s.status} · ${s.detail}`}</li>
            ))}
          </ul>
          <p className="muted small">Cost ${job.costUsd.toFixed(2)}</p>
        </>
      ) : null}
      {job.status === 'failed' ? (
        <p className="error">
          Failed: <span className="pre">{job.error ?? 'No details.'}</span>
        </p>
      ) : null}
    </div>
  );
}
