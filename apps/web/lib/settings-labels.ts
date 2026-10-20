import type { EditableSettingKey } from '@bcg/core/dashboard/settings';

/** Form labels and hints for the editable settings (sender identity for CASL footers; landing-page settings). */
export const SETTING_FIELDS: Record<EditableSettingKey, { label: string; hint?: string }> = {
  'sender.name': { label: 'Your name' },
  'sender.company': { label: 'Company (optional)' },
  'sender.address': { label: 'Mailing address', hint: 'Required in every outreach email (CASL / CAN-SPAM).' },
  'sender.contact': { label: 'Phone or website' },
  'sender.email': { label: 'Reply-to email (optional)' },
  'landing.privacyContact': { label: 'Privacy contact', hint: 'Shown on landing pages.' },
  'landing.formEndpoint': { label: 'Form endpoint', hint: 'An https:// URL, or empty.' },
};
