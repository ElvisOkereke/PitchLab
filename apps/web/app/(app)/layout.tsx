import { getTourState, tourCaseSlug } from '@bcg/core/dashboard/tour';
import type { ReactNode } from 'react';
import { logoutAction } from '@/actions/auth';
import { Nav } from '@/components/nav';
import { TourButton } from '@/components/tour/tour-button';
import { TourProvider } from '@/components/tour/tour-provider';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

/** App shell for every signed-in page: nav tabs, the tour and logout. Second auth layer behind proxy.ts. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireOwner();
  const db = getDb();
  const [tourState, caseSlug] = await Promise.all([getTourState(db), tourCaseSlug(db)]);
  return (
    <TourProvider initial={tourState} caseSlug={caseSlug}>
      <div className="shell">
        <header className="app-header">
          <Nav />
          <div className="header-actions">
            <TourButton />
            <form action={logoutAction} className="logout">
              <button type="submit" className="secondary">
                Log out
              </button>
            </form>
          </div>
        </header>
        {children}
      </div>
    </TourProvider>
  );
}
