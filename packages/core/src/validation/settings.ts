import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';

/** Owner identity used in every outreach footer (CASL, spec §11.6). */
export const SENDER_KEYS = ['sender.name', 'sender.company', 'sender.address', 'sender.contact', 'sender.email'] as const;
export type SenderKey = (typeof SENDER_KEYS)[number];

/** A complete identity needs a name, a mailing address and one other contact method (phone or website). */
const REQUIRED_SENDER_KEYS = ['sender.name', 'sender.address', 'sender.contact'] as const satisfies readonly SenderKey[];

export type Sender = { name: string; company?: string; address: string; contact: string; email?: string };

/** The stored JSON value, or null when the key is not set. */
export async function getSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

/** Insert or replace a setting. */
export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** A trimmed non-empty string value, else null (unset, blank or not a string). */
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The sender identity when complete, plus the required keys that are missing (in SENDER_KEYS order). */
export async function getSender(db: Db): Promise<{ sender: Sender | null; missing: string[] }> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [...SENDER_KEYS]));
  const values = new Map<string, string | null>(rows.map((r) => [r.key, str(r.value)]));
  for (const key of SENDER_KEYS) if (!values.has(key)) values.set(key, null);
  const missing = REQUIRED_SENDER_KEYS.filter((k) => values.get(k) === null);
  if (missing.length) return { sender: null, missing };
  const company = values.get('sender.company');
  const email = values.get('sender.email');
  return {
    sender: {
      name: values.get('sender.name')!,
      ...(company ? { company } : {}),
      address: values.get('sender.address')!,
      contact: values.get('sender.contact')!,
      ...(email ? { email } : {}),
    },
    missing: [],
  };
}
