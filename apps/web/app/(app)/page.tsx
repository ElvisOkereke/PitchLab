import { caseStage } from '@bcg/core/db/schema';

export default function BoardPage() {
  return (
    <main>
      <h1>Board</h1>
      <p className="muted">The pipeline board is coming: {caseStage.enumValues.join(' · ')}.</p>
    </main>
  );
}
