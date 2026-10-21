import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the repo-root .env into process.env; values already set (the shell) win, like the CLI's loader.
 * Not @next/env's loadEnvConfig: Next calls that first for apps/web (which has no .env) and caches the result,
 * so a second call for the repo root returns the cache and loads nothing.
 */
export function loadRepoEnv(repoRoot: string): void {
  const path = join(repoRoot, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
