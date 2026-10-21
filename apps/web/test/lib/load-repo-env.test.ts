import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvConfig } from '@next/env';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRepoEnv } from '@/lib/load-repo-env';

const KEYS = ['BCG_TEST_FROM_FILE', 'BCG_TEST_SHELL_WINS'];

describe('loadRepoEnv', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bcg-env-')); dirs.push(d); return d; };
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('loads the repo-root .env even after Next has loaded (and cached) env for apps/web', () => {
    loadEnvConfig(tmp(), true); // what next dev does first, for the app folder with no .env
    const root = tmp();
    writeFileSync(join(root, '.env'), 'BCG_TEST_FROM_FILE=loaded\nBCG_TEST_SHELL_WINS=file\n');
    process.env.BCG_TEST_SHELL_WINS = 'shell';
    loadRepoEnv(root);
    expect(process.env.BCG_TEST_FROM_FILE).toBe('loaded');
    expect(process.env.BCG_TEST_SHELL_WINS).toBe('shell');
  });

  it('does nothing when there is no .env', () => {
    expect(() => loadRepoEnv(tmp())).not.toThrow();
    expect(process.env.BCG_TEST_FROM_FILE).toBeUndefined();
  });
});
