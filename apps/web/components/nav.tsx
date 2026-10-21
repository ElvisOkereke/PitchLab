'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// `data-tour` marks the tabs the guided tour points at.
const TABS: readonly { href: string; label: string; 'data-tour'?: string }[] = [
  { href: '/', label: 'Board' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/command', label: 'Command center', 'data-tour': 'nav-command' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings', label: 'Settings', 'data-tour': 'nav-settings' },
];

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
        <Link key={t.href} href={t.href} className="nav-tab" data-tour={t['data-tour']} aria-current={isActive(pathname, t.href) ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
