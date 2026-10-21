import { z } from 'zod';

/** Outcomes shown on Settings (allow-listed; the query value is only a key, never echoed). */
export const SETTINGS_NOTICES = {
  example_hidden: 'The example case is hidden. Reset it in Settings any time to bring it back.',
  example_reset: 'The example case is restored and shown again.',
} as const;
export type SettingsNotice = keyof typeof SETTINGS_NOTICES;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const NoticeSchema = z.preprocess(first, z.enum(Object.keys(SETTINGS_NOTICES) as [SettingsNotice, ...SettingsNotice[]]).optional()).catch(undefined);

export function parseSettingsNotice(sp: Record<string, string | string[] | undefined>): SettingsNotice | undefined {
  return NoticeSchema.parse(sp.notice);
}

export function settingsHref(notice?: SettingsNotice): string {
  return notice ? `/settings?notice=${notice}` : '/settings';
}
