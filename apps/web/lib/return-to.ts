import { safeNext } from './auth/safe-next';

/**
 * Where a form wants the owner to land after the action (`returnTo` field): undefined when absent, otherwise the
 * safeNext-normalised same-origin path (anything off-site becomes `/`).
 */
export function returnPath(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return safeNext(raw);
}

/** `path` with its `notice` query parameter set to `notice` (replacing any earlier one); still same-origin. */
export function withNotice(path: string, notice: string): string {
  const u = new URL(safeNext(path), 'http://x');
  u.searchParams.set('notice', notice);
  return safeNext(u.pathname + u.search);
}
