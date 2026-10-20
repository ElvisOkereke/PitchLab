import type { NeedsYouItem } from '@bcg/core/dashboard/command';
import type { RunListRow, RunStatus } from '@bcg/core/dashboard/runs';
import type { WorkerStatus } from '@bcg/core/dashboard/settings';
import Link from 'next/link';
import { safeNext } from '@/lib/auth/safe-next';
import { runCost, seedSummary } from '@/lib/run-format';
import { formatDateTime, relativeTime, usd } from '@/lib/time';

type Spend = { llmUsd: number; dataUsd: number; llmCalls: number };

export type CommandData = {
  now: Date;
  needsYou: NeedsYouItem[];
  spend: { today: Spend; week: Spend };
  worker: WorkerStatus | null;
  runs: Record<RunStatus, number>;
  recent: RunListRow[];
};

/** A heartbeat older than this means the worker is not running. */
export const WORKER_FRESH_MS = 60_000;

const KIND: Record<NeedsYouItem['kind'], { icon: string; label: string }> = {
  score: { icon: '✍️', label: 'Score' },
  advisory: { icon: '⚠️', label: 'Keep or kill' },
  reply: { icon: '📬', label: 'Log a reply' },
  failed_run: { icon: '❌', label: 'Failed run' },
};

const spendLine = (s: Spend) => `LLM ${usd(s.llmUsd)} (notional) · data ${usd(s.dataUsd)} · ${s.llmCalls} calls`;

function workerSeen(worker: WorkerStatus | null, now: Date): { fresh: boolean; at: Date | null } {
  const at = worker ? new Date(worker.at) : null;
  if (!at || Number.isNaN(at.getTime())) return { fresh: false, at: null };
  return { fresh: now.getTime() - at.getTime() <= WORKER_FRESH_MS, at };
}

/** "Needs you", spend today and this week, generator status and the latest runs. */
export function CommandCenter({ data }: { data: CommandData }) {
  const { now } = data;
  const seen = workerSeen(data.worker, now);
  const secondsAgo = seen.at ? Math.max(0, Math.round((now.getTime() - seen.at.getTime()) / 1000)) : 0;
  return (
    <main className="command-page">
      <h1>Command center</h1>

      <section data-testid="needs-you" aria-labelledby="needs-you-title" className="card">
        <h2 id="needs-you-title">Needs you ({data.needsYou.length})</h2>
        {data.needsYou.length === 0 ? <p className="muted">Nothing needs you right now.</p> : null}
        <ul className="plain stack">
          {data.needsYou.map((item, i) => (
            <li key={`${item.kind}-${i}`} className="needs-you-item">
              <span aria-hidden="true">{KIND[item.kind].icon}</span> <span className="visually-hidden">{KIND[item.kind].label}: </span>
              <Link href={safeNext(item.href)}>{item.label}</Link> <span className="muted small">{relativeTime(item.at, now)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="spend" aria-labelledby="spend-title" className="card">
        <h2 id="spend-title">Spend</h2>
        <dl className="fields">
          <div>
            <dt>Today</dt>
            <dd>{spendLine(data.spend.today)}</dd>
          </div>
          <div>
            <dt>This week (from Monday)</dt>
            <dd>{spendLine(data.spend.week)}</dd>
          </div>
        </dl>
        <p className="muted small">No caps configured (Plan 4)</p>
      </section>

      <section data-testid="worker" aria-labelledby="worker-title" className="card">
        <h2 id="worker-title">Generator</h2>
        <p>
          Worker:{' '}
          {seen.fresh ? (
            <span className="badge badge-ok">last seen {secondsAgo} s ago</span>
          ) : (
            <span className="badge badge-warn">not seen</span>
          )}
          {!seen.fresh && seen.at ? <span className="muted small"> (last heartbeat {relativeTime(seen.at, now)})</span> : null}
        </p>
        {!seen.fresh ? <p className="muted small">Start it with npm run worker.</p> : null}
        <p>
          Runs: {data.runs.queued} queued · {data.runs.running} running · <Link href="/runs">Runs</Link>
        </p>
      </section>

      <section data-testid="recent-runs" aria-labelledby="recent-title" className="card">
        <h2 id="recent-title">Recent runs</h2>
        {data.recent.length === 0 ? <p className="muted">No runs yet.</p> : null}
        <ul className="plain stack">
          {data.recent.map((r) => (
            <li key={r.id}>
              <span className={`badge ${r.status === 'failed' ? 'badge-bad' : r.status === 'succeeded' ? 'badge-ok' : 'badge-info'}`}>{r.status}</span>{' '}
              {seedSummary(r.config)} · {formatDateTime(r.createdAt)} · {runCost(r.costUsd)} · {r.caseCount} cases
            </li>
          ))}
        </ul>
        <p>
          <Link href="/runs">All runs</Link>
        </p>
      </section>
    </main>
  );
}
