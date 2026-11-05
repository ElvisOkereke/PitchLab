import type { RunOrigin } from '@bcg/core/dashboard/runs';
import Link from 'next/link';
import { seedSummary } from '@/lib/run-format';
import { runLinkHref } from '@/lib/runs-query';
import { formatDate } from '@/lib/time';

/** "From: 20 Oct 2026 · sector: HVAC · bench-v3 #1", linking to that run in the Runs history. Plain text only. */
export function RunOriginLine({ origin, className }: { origin: RunOrigin | null | undefined; className?: string }) {
  if (!origin) return null;
  const parts = [formatDate(origin.createdAt), seedSummary(origin.seed), ...(origin.passLabel ? [origin.passLabel] : [])];
  return (
    <p className={className ?? 'muted small'} data-testid="case-origin">
      From: <Link href={runLinkHref(origin.runId)}>{parts.join(' · ')}</Link>
    </p>
  );
}
