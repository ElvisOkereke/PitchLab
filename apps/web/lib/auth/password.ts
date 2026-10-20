import 'server-only';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Format: scrypt:<N>:<r>:<p>:<salt b64url>:<key b64url>. ':' separators (never '$', which @next/env expands in .env).
const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAXMEM = 64 * 1024 * 1024;
const MAX_N = 2 ** 20;
const B64URL = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^\d{1,8}$/;

function derive(password: string, salt: Buffer, keylen: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, o, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** A new scrypt hash (N=2^15, r=8, p=1, 16-byte random salt, 64-byte key). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

/** Re-derives the key with the stored parameters and compares in constant time. Never throws: anything odd is false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nS, rS, pS, saltS, keyS] = parts as [string, string, string, string, string, string];
    if (![nS, rS, pS].every((s) => DIGITS.test(s)) || !B64URL.test(saltS) || !B64URL.test(keyS)) return false;
    const n = Number(nS);
    const r = Number(rS);
    const p = Number(pS);
    if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
    const salt = Buffer.from(saltS, 'base64url');
    const expected = Buffer.from(keyS, 'base64url');
    if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
    const actual = await derive(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
