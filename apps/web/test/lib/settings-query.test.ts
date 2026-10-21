import { describe, expect, it } from 'vitest';
import { parseSettingsNotice } from '@/lib/settings-query';

describe('parseSettingsNotice', () => {
  it('allows only known keys', () => {
    expect(parseSettingsNotice({ notice: 'example_hidden' })).toBe('example_hidden');
    expect(parseSettingsNotice({ notice: ['example_reset', 'x'] })).toBe('example_reset');
    expect(parseSettingsNotice({ notice: '<b>x</b>' })).toBeUndefined();
    expect(parseSettingsNotice({})).toBeUndefined();
  });
});
