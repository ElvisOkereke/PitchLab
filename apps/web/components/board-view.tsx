import type { BoardCard, GateKill } from '@bcg/core/dashboard/board';
import type { CaseStage } from '@bcg/core/db/schema';
import Link from 'next/link';
import { rerunGateKillAction } from '@/actions/stage';
import { BOARD_NOTICES, boardHref, selectedStage, type BoardQuery } from '@/lib/board-query';
import { checkLabel } from '@/lib/gate';
import { STAGES, STAGE_LABEL } from '@/lib/stages';
import { CaseCard } from './case-card';

export type BoardViewProps = {
  board: { columns: Record<CaseStage, BoardCard[]>; counts: Record<CaseStage, number> };
  gateKills: GateKill[];
  lenses: { id: string; name: string }[];
  query: BoardQuery;
};

const MIN_AI_OPTIONS = [2, 3, 3.5, 4, 4.5];

/**
 * The pipeline board. Wide screens: 5 columns. Phones (< 768px): a stage switcher with counts plus the selected
 * column only (CSS hides the others), so the page never scrolls sideways.
 */
export function BoardView({ board, gateKills, lenses, query }: BoardViewProps) {
  const selected = selectedStage(query.stage, board.counts);
  const filters = { lens: query.lens, minAi: query.minAi };
  const filtered = filters.lens !== undefined || filters.minAi !== undefined;

  return (
    <main className="board-page">
      <h1 className="visually-hidden">Board</h1>
      {query.notice ? (
        <p className="notice card" role="status">
          {BOARD_NOTICES[query.notice]}
        </p>
      ) : null}

      <form method="get" action="/" className="board-filters">
        <input type="hidden" name="stage" value={selected} />
        <label>
          <span className="visually-hidden">Lens</span>
          <select name="lens" defaultValue={filters.lens ?? ''}>
            <option value="">All lenses</option>
            {lenses.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Minimum AI score</span>
          <select name="minAi" defaultValue={filters.minAi === undefined ? '' : String(filters.minAi)}>
            <option value="">Any AI score</option>
            {MIN_AI_OPTIONS.map((v) => (
              <option key={v} value={String(v)}>
                AI ≥ {v}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary">
          Filter
        </button>
        {filtered ? <Link href={boardHref({ stage: selected })}>Clear</Link> : null}
      </form>

      <nav aria-label="Stages" className="board-switcher">
        {STAGES.map((s) => (
          <Link key={s} href={boardHref({ ...filters, stage: s })} className={`stage-link stage-${s}`} aria-current={s === selected ? 'page' : undefined}>
            {STAGE_LABEL[s]} <span className="count">{board.counts[s]}</span>
          </Link>
        ))}
      </nav>

      <div className="board">
        {STAGES.map((s) => {
          const cards = board.columns[s];
          return (
            <section key={s} className={`column stage-${s}`} data-stage={s} data-count={board.counts[s]} data-selected={s === selected ? 'true' : 'false'} aria-labelledby={`col-${s}`}>
              <h2 id={`col-${s}`} className="column-title">
                {STAGE_LABEL[s]} <span className="count">{board.counts[s]}</span>
              </h2>
              {cards.length === 0 ? <p className="muted">No cases.</p> : null}
              {cards.map((c) => (
                <CaseCard key={c.id} card={c} />
              ))}
              {board.counts[s] > cards.length ? (
                <p className="muted">
                  Showing {cards.length} of {board.counts[s]}.
                </p>
              ) : null}
              {s === 'killed' ? <GateKills kills={gateKills} /> : null}
            </section>
          );
        })}
      </div>
    </main>
  );
}

/** Ideas the gate killed (read-only), each with its failed checks and a "Re-run as owner idea" button. */
function GateKills({ kills }: { kills: GateKill[] }) {
  return (
    <details className="gate-kills" data-testid="gate-kills">
      <summary>Gate kills ({kills.length})</summary>
      {kills.length === 0 ? <p className="muted">None.</p> : null}
      <ul className="plain">
        {kills.map((k) => (
          <li key={k.ideaId} className="card gate-kill">
            <strong>{k.title}</strong>
            <p className="pre muted">{k.oneLiner}</p>
            <ul className="failed-checks">
              {k.failed.map((f) => (
                <li key={f.check}>
                  <span className="check">❌ {checkLabel(f.check)}:</span> <span className="pre">{f.reasoning}</span>
                </li>
              ))}
            </ul>
            <form action={rerunGateKillAction}>
              <input type="hidden" name="ideaId" value={k.ideaId} />
              <button type="submit" className="secondary">
                Re-run as owner idea
              </button>
            </form>
            <p className="muted small">Queues a full case run.</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
