import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ModelStage } from '../config/models';
import { MODEL_STAGES } from '../config/models';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import { LANDING_KEYS, SENDER_KEYS, getSetting } from '../validation/settings';

/** The only settings the dashboard form may write. */
export const EDITABLE_SETTING_KEYS = [...SENDER_KEYS, ...LANDING_KEYS] as const;
export type EditableSettingKey = (typeof EDITABLE_SETTING_KEYS)[number];

const value = z.string().trim().max(500, 'At most 500 characters.');

function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Every value a trimmed string ≤ 500 chars; `landing.formEndpoint` empty or an https URL. Unknown keys are dropped. */
export const SettingsInputSchema = z.object(
  Object.fromEntries(EDITABLE_SETTING_KEYS.map((k) => [k,
    (k === 'landing.formEndpoint'
      ? value.refine((v) => v === '' || isHttpsUrl(v), 'The form endpoint must be an https URL (or empty).')
      : value
    ).optional(),
  ])) as Record<EditableSettingKey, z.ZodOptional<typeof value>>,
);
export type SettingsInput = Partial<Record<EditableSettingKey, string>>;

/** Writes every given key in one transaction (insert or replace). */
export async function saveSettings(db: Db, input: SettingsInput): Promise<{ saved: number }> {
  const parsed = SettingsInputSchema.parse(input) as SettingsInput;
  const entries = EDITABLE_SETTING_KEYS.flatMap((k) => (parsed[k] === undefined ? [] : [[k, parsed[k]!] as const]));
  await db.transaction(async (tx) => {
    for (const [key, v] of entries) {
      await tx.insert(settings).values({ key, value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
    }
  });
  return { saved: entries.length };
}

/** Every editable setting's current value for the form: the stored string, or '' when unset or not a string. */
export async function readEditableSettings(db: Db): Promise<Record<EditableSettingKey, string>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [...EDITABLE_SETTING_KEYS]));
  const values = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(EDITABLE_SETTING_KEYS.map((k) => {
    const v = values.get(k);
    return [k, typeof v === 'string' ? v : ''];
  })) as Record<EditableSettingKey, string>;
}

/** True when the database answers `select 1`. The error (which may name the host) is swallowed, never shown. */
export async function databaseReachable(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Where `gen worker` writes its heartbeat. Never editable from the dashboard. */
export const WORKER_STATUS_KEY = 'worker.status';

export type WorkerStatus = {
  /** ISO time of the last heartbeat. */
  at: string;
  /** Which providers have a key configured on the worker (booleans only, never values). */
  providers: { llm: boolean; github: boolean; stackexchange: boolean; places: boolean };
  models: Record<ModelStage, string>;
};

const WorkerStatusSchema = z.object({
  at: z.string().max(40),
  providers: z.object({ llm: z.boolean(), github: z.boolean(), stackexchange: z.boolean(), places: z.boolean() }),
  models: z.object(Object.fromEntries(MODEL_STAGES.map((s) => [s, z.string().max(200)])) as Record<ModelStage, z.ZodString>),
});

/** The last worker heartbeat, or null when none was written or it is malformed. */
export async function readWorkerStatus(db: Db): Promise<WorkerStatus | null> {
  const parsed = WorkerStatusSchema.safeParse(await getSetting(db, WORKER_STATUS_KEY));
  return parsed.success ? parsed.data : null;
}
