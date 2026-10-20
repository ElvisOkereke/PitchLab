import type { ReactNode } from 'react';
import { logoutAction } from '@/actions/auth';
import { Nav } from '@/components/nav';
import { requireOwner } from '@/lib/auth/require-owner';

/** App shell for every signed-in page: nav tabs and logout. Second auth layer behind proxy.ts. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireOwner();
  return (
    <div className="shell">
      <header className="app-header">
        <Nav />
        <form action={logoutAction} className="logout">
          <button type="submit" className="secondary">
            Log out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
