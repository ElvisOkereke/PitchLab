import { linkFlags } from '@bcg/core/case/review';
import { getCaseView } from '@bcg/core/dashboard/case-view';
import { getValidateView } from '@bcg/core/dashboard/validate-view';
import { latestValidationJob } from '@bcg/core/dashboard/validation-jobs';
import { getSender } from '@bcg/core/validation/settings';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/auto-refresh';
import { CaseHeader } from '@/components/case-header';
import { CompetitorsTab } from '@/components/tabs/competitors';
import { EvidenceTab } from '@/components/tabs/evidence';
import { NumbersTab } from '@/components/tabs/numbers';
import { PitchTab } from '@/components/tabs/pitch';
import { ScoreTab } from '@/components/tabs/score';
import { SummaryTab } from '@/components/tabs/summary';
import { ValidateTab } from '@/components/tabs/validate';
import { requireOwner } from '@/lib/auth/require-owner';
import { parseCaseQuery } from '@/lib/case-query';
import { getDb } from '@/lib/db';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** One case: header with stage controls, then the selected tab (`?tab=`; each tab is its own server render). */
export default async function CasePage({ params, searchParams }: Props) {
  await requireOwner();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const query = parseCaseQuery(sp);
  const db = getDb();
  const view = await getCaseView(db, slug);
  if (!view) notFound();

  const flags = linkFlags(view.claims);
  let content: ReactNode;
  switch (query.tab) {
    case 'summary':
      content = <SummaryTab view={view} flags={flags} />;
      break;
    case 'evidence':
      content = <EvidenceTab view={view} flags={flags} />;
      break;
    case 'numbers':
      content = <NumbersTab view={view} flags={flags} />;
      break;
    case 'competitors':
      content = <CompetitorsTab view={view} flags={flags} />;
      break;
    case 'pitch':
      content = <PitchTab view={view} />;
      break;
    case 'validate': {
      const [validate, job, sender] = await Promise.all([
        getValidateView(db, view.case.id, { page: query.page }),
        latestValidationJob(db, view.case.id),
        getSender(db),
      ]);
      const busy = job?.status === 'queued' || job?.status === 'running';
      content = (
        <>
          {busy ? <AutoRefresh everyMs={10_000} /> : null}
          <ValidateTab view={view} validate={validate} page={query.page} job={job} senderMissing={sender.missing} />
        </>
      );
      break;
    }
    case 'score':
      content = <ScoreTab view={view} />;
      break;
  }

  return (
    <div className="case-page">
      <CaseHeader view={view} tab={query.tab} notice={query.notice} />
      <main id="case-content" data-tab={query.tab}>
        {content}
      </main>
    </div>
  );
}
