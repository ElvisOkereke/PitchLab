import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The npm workspaces root: the nearest folder at or above `start` whose package.json declares `workspaces`. */
export function findRepoRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && 'workspaces' in JSON.parse(readFileSync(pkg, 'utf8'))) return dir;
    if (dirname(dir) === dir) throw new Error('Could not find the PitchLab folder (the npm workspaces root).');
  }
}
