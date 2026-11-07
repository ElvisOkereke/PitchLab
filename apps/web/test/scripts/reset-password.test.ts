import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '@/lib/auth/password';
import { resetPassword } from '../../scripts/lib/reset-password-flow';
import { findRepoRoot } from '../../scripts/lib/repo-root';

const PASSWORD = 'a-long-enough-test-password';
let dir: string;
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const value = (text: string, key: string) => new RegExp(`^${key}=(.*?)\\r?$`, 'm').exec(text)?.[1] ?? '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reset-pw-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resetPassword', () => {
  it('refuses when .env is missing and creates nothing', async () => {
    const r = await resetPassword({ repoRoot: dir, password: PASSWORD, keepSessions: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/\.env\.example/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a password shorter than 12 characters and leaves .env alone', async () => {
    writeFileSync(join(dir, '.env'), 'A=1\n');
    const r = await resetPassword({ repoRoot: dir, password: 'short', keepSessions: false });
    expect(r.ok).toBe(false);
    expect(read('.env')).toBe('A=1\n');
    expect(existsSync(join(dir, '.env.bak'))).toBe(false);
  });

  it('writes a hash that verifies, rotates SESSION_SECRET, keeps other lines and writes .env.bak', async () => {
    const original = '# c\r\nA=1\r\nOWNER_PASSWORD_HASH=old\r\nSESSION_SECRET=oldsecret\r\nZ=9\r\n';
    writeFileSync(join(dir, '.env'), original);
    const r = await resetPassword({ repoRoot: dir, password: PASSWORD, keepSessions: false });
    expect(r).toEqual({ ok: true, sessionsRotated: true });
    const env = read('.env');
    expect(await verifyPassword(PASSWORD, value(env, 'OWNER_PASSWORD_HASH'))).toBe(true);
    const secret = value(env, 'SESSION_SECRET');
    expect(secret).not.toBe('oldsecret');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.startsWith('# c\r\nA=1\r\n')).toBe(true);
    expect(env.endsWith('Z=9\r\n')).toBe(true);
    expect(env.replace(/\r\n/g, '')).not.toContain('\n');
    expect(read('.env.bak')).toBe(original);
    expect(readdirSync(dir).sort()).toEqual(['.env', '.env.bak']);
  });

  it('keeps SESSION_SECRET with keepSessions and overwrites the previous backup', async () => {
    writeFileSync(join(dir, '.env'), 'OWNER_PASSWORD_HASH=old\nSESSION_SECRET=keepme\n');
    writeFileSync(join(dir, '.env.bak'), 'stale\n');
    const r = await resetPassword({ repoRoot: dir, password: PASSWORD, keepSessions: true });
    expect(r).toEqual({ ok: true, sessionsRotated: false });
    expect(value(read('.env'), 'SESSION_SECRET')).toBe('keepme');
    expect(read('.env.bak')).toBe('OWNER_PASSWORD_HASH=old\nSESSION_SECRET=keepme\n');
  });

  it('appends both keys when missing', async () => {
    writeFileSync(join(dir, '.env'), 'A=1\n');
    await resetPassword({ repoRoot: dir, password: PASSWORD, keepSessions: false });
    const env = read('.env');
    expect(value(env, 'OWNER_PASSWORD_HASH')).toMatch(/^scrypt:/);
    expect(value(env, 'SESSION_SECRET')).not.toBe('');
  });

  it('does not put the hash or secret in the result', async () => {
    writeFileSync(join(dir, '.env'), 'A=1\n');
    const r = await resetPassword({ repoRoot: dir, password: PASSWORD, keepSessions: false });
    const env = read('.env');
    expect(JSON.stringify(r)).not.toContain(value(env, 'OWNER_PASSWORD_HASH'));
    expect(JSON.stringify(r)).not.toContain(value(env, 'SESSION_SECRET'));
  });
});

describe('findRepoRoot', () => {
  it('finds the nearest folder whose package.json declares workspaces', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
    mkdirSync(join(dir, 'apps', 'web', 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), '{}');
    expect(findRepoRoot(join(dir, 'apps', 'web', 'scripts'))).toBe(dir);
  });
});
