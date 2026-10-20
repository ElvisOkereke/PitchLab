'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const MIN_MS = 2_000;

/** Re-renders the current route on an interval (mounted only while runs are queued or running). Renders nothing. */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), Math.max(everyMs, MIN_MS));
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
