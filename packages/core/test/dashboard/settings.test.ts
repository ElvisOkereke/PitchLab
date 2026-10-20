import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../../src/config/models';
import {
  EDITABLE_SETTING_KEYS, SettingsInputSchema, WORKER_STATUS_KEY, databaseReachable, readEditableSettings, readWorkerStatus, saveSettings,
} from '../../src/dashboard/settings';
import { getSetting, setSetting } from '../../src/validation/settings';
import { testDb } from '../helpers/db';

describe('dashboard settings', () => {
  it('edits sender.* and landing.* only', () => {
    expect(EDITABLE_SETTING_KEYS).toEqual([
      'sender.name', 'sender.company', 'sender.address', 'sender.contact', 'sender.email', 'landing.privacyContact', 'landing.formEndpoint',
    ]);
    const parsed = SettingsInputSchema.parse({ 'sender.name': '  Al  ', 'worker.status': 'x', other: 'y' });
    expect(parsed).toEqual({ 'sender.name': 'Al' });
  });

  it('accepts an empty or https form endpoint only, and values up to 500 chars', () => {
    expect(SettingsInputSchema.safeParse({ 'landing.formEndpoint': '' }).success).toBe(true);
    expect(SettingsInputSchema.safeParse({ 'landing.formEndpoint': 'https://forms.test/x' }).success).toBe(true);
    for (const bad of ['http://forms.test/x', 'javascript:alert(1)', 'not a url', 'https://user:pw@forms.test/']) {
      expect(SettingsInputSchema.safeParse({ 'landing.formEndpoint': bad }).success).toBe(false);
    }
    expect(SettingsInputSchema.safeParse({ 'sender.address': 'x'.repeat(501) }).success).toBe(false);
  });

  it('saveSettings writes every given key in one go and never worker.status', async () => {
    const db = await testDb();
    await setSetting(db, WORKER_STATUS_KEY, { keep: true });
    const r = await saveSettings(db, SettingsInputSchema.parse({ 'sender.name': 'Al', 'landing.formEndpoint': '', 'worker.status': 'hacked' }));
    expect(r).toEqual({ saved: 2 });
    expect(await getSetting(db, 'sender.name')).toBe('Al');
    expect(await getSetting(db, 'landing.formEndpoint')).toBe('');
    expect(await getSetting(db, WORKER_STATUS_KEY)).toEqual({ keep: true });
  });

  it('readEditableSettings returns every editable key as a string (blank when unset or not a string), nothing else', async () => {
    const db = await testDb();
    await setSetting(db, 'sender.name', 'Al');
    await setSetting(db, 'sender.address', { not: 'a string' });
    await setSetting(db, WORKER_STATUS_KEY, { at: 'x' });
    const values = await readEditableSettings(db);
    expect(Object.keys(values)).toEqual([...EDITABLE_SETTING_KEYS]);
    expect(values['sender.name']).toBe('Al');
    expect(values['sender.address']).toBe('');
    expect(values['landing.formEndpoint']).toBe('');
  });

  it('databaseReachable answers select 1', async () => {
    const db = await testDb();
    expect(await databaseReachable(db)).toBe(true);
    const broken = { execute: async () => { throw new Error('connect ECONNREFUSED postgres://u:secret@h/db'); } } as unknown as typeof db;
    expect(await databaseReachable(broken)).toBe(false);
  });

  it('readWorkerStatus returns a well-formed heartbeat or null', async () => {
    const db = await testDb();
    expect(await readWorkerStatus(db)).toBeNull();
    await setSetting(db, WORKER_STATUS_KEY, { garbage: 1 });
    expect(await readWorkerStatus(db)).toBeNull();
    const status = {
      at: '2026-10-19T12:00:00.000Z', providers: { llm: true, github: false, stackexchange: false, places: true }, models: DEFAULT_MODELS,
    };
    await setSetting(db, WORKER_STATUS_KEY, status);
    expect(await readWorkerStatus(db)).toEqual(status);
  });
});
