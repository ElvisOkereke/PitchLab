'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Board' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/command', label: 'Command center' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings', label: 'Settings' },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/cases/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The main tabs. On narrow screens they wrap onto a second row (no hamburger menu). */
export function Nav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Main" className="nav">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className="nav-tab" aria-current={isActive(pathname, t.href) ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
