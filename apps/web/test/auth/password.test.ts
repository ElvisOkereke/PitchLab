import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

describe('password hashing', () => {
  it('password round trip; wrong or malformed fails without throwing', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(h).not.toContain('$');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('nope', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('uses a fresh 16-byte salt and a 64-byte key', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    expect(a).not.toBe(b);
    const [, , , , salt, key] = a.split(':');
    expect(Buffer.from(salt!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64url')).toHaveLength(64);
  });

  it('rejects malformed or hostile parameters without throwing', async () => {
    const h = await hashPassword('correct horse battery');
    const [, , , , salt, key] = h.split(':');
    const bad = [
      '',
      'scrypt:32768:8:1:' + salt,
      `bcrypt:32768:8:1:${salt}:${key}`,
      `scrypt:${2 ** 21}:8:1:${salt}:${key}`, // N > 2^20
      `scrypt:1000:8:1:${salt}:${key}`, // not a power of two
      `scrypt:32768:0:1:${salt}:${key}`,
      `scrypt:32768:8:abc:${salt}:${key}`,
      `scrypt:32768:8:1:${salt}:${key}:extra`,
      `scrypt:32768:8:1:${salt}:!!`,
      `scrypt:32768:8:1::${key}`,
      '$scrypt$32768$8$1$a$b',
    ];
    for (const stored of bad) expect(await verifyPassword('correct horse battery', stored)).toBe(false);
    expect(await verifyPassword(undefined as unknown as string, h)).toBe(false);
  });
});
