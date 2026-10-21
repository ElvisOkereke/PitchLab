import type { BoardCard } from '@bcg/core/dashboard/board';
import Link from 'next/link';
import { formatScore } from '@/lib/stages';
import { ExampleBadge } from './example-badge';
import { StageMoveForm } from './stage-move-form';

/**
 * A board card: title link, AI score, owner score, key metric and a compact stage-move form. `tourAnchor` marks the
 * one card the guided tour points at (the first card of the column shown on phones).
 */
export function CaseCard({ card, tourAnchor = false }: { card: BoardCard; tourAnchor?: boolean }) {
  return (
    <article className="case-card card" data-case={card.slug} data-tour={tourAnchor ? 'board-first-card' : undefined}>
      <h3 className="case-card-title">
        <Link href={`/cases/${card.slug}`}>{card.title}</Link>
        {card.isExample ? <> <ExampleBadge /></> : null}
      </h3>
      <dl className="case-card-stats">
        <div>
          <dt>AI</dt>
          <dd>{formatScore(card.aiScore)}</dd>
        </div>
        <div>
          <dt>You</dt>
          <dd>{formatScore(card.ownerScore)}</dd>
        </div>
        <div className="case-card-metric">
          <dt className="visually-hidden">Key metric</dt>
          <dd>{card.metric}</dd>
        </div>
      </dl>
      <StageMoveForm caseId={card.id} slug={card.slug} stage={card.stage} />
    </article>
  );
}
