import { isIP } from 'node:net';

/**
 * The rate-limit bucket for a request. With 0 trusted proxy hops X-Forwarded-For is ignored and every request shares
 * the bucket `'all'`. With N hops the key is the Nth entry from the right (the address the outermost trusted proxy
 * saw), so entries a client prepends cannot change it. A missing or non-IP entry becomes `'unknown'`.
 */
export function clientKey(h: Headers, trustHops: number): string {
  if (!Number.isInteger(trustHops) || trustHops <= 0) return 'all';
  const entries = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const entry = entries[entries.length - trustHops];
  return entry !== undefined && isIP(entry) ? entry.toLowerCase() : 'unknown';
}
