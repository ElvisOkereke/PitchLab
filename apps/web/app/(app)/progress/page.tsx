import { BENCHMARKS, CURRENT_BENCHMARK } from '@bcg/core/bench/definitions';
import { listBenchmarkPasses, passCases, passProgress } from '@bcg/core/bench/passes';
import { AutoRefresh } from '@/components/auto-refresh';
import { HelpTip } from '@/components/help-tip';
import { ProgressView } from '@/components/progress-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

const REFRESH_MS = 10_000;

/** Idea-quality scorecard: the baseline against your benchmark passes, plus the cases to score. */
export default async function ProgressPage() {
  await requireOwner();
  const db = getDb();
  const passes = await listBenchmarkPasses(db, 50);
  const runningPass = passes.find((p) => p.status === 'running') ?? null;
  const progress = runningPass ? await passProgress(db, runningPass.id) : null;
  const finished = passes.find((p) => p.kind === 'pass' && p.status !== 'running') ?? null;
  const cases = finished ? await passCases(db, finished.id) : null;
  const running =
    runningPass && progress
      ? { label: runningPass.label, done: progress.succeeded + progress.failed, total: runningPass.runIds.length }
      : null;
  return (
    <main className="progress-page">
      <div className="label-row">
        <h1>Progress</h1>
        <HelpTip term="benchmark" />
      </div>
      <p>Measures how varied, well-evidenced and valuable your generated ideas are. Run the benchmark after each change and compare.</p>
      <ProgressView
        passes={passes}
        running={running}
        scoreCases={finished && cases ? { label: finished.label, cases } : null}
        costNote={BENCHMARKS[CURRENT_BENCHMARK].costNote}
      />
      {running ? <AutoRefresh everyMs={REFRESH_MS} /> : null}
    </main>
  );
}
