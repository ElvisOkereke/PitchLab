import { describe, expect, it } from 'vitest';

type Needles = { needles: { label: string }[]; skipped: string[] };
// Plain .mjs script (allowJs is off): imported through a variable so tsc does not resolve it.
const script = '../scripts/check-bundle.mjs';
const { bundleNeedles } = (await import(/* @vite-ignore */ script)) as { bundleNeedles: (env: Record<string, string>) => Needles };

describe('check-bundle needles', () => {
  it('searches the bundle for YOUTUBE_API_KEY when it is set, by label only', () => {
    const { needles } = bundleNeedles({ YOUTUBE_API_KEY: 'test-only-not-a-real-key-123456' });
    expect(needles.map((n) => n.label)).toContain('YOUTUBE_API_KEY');
    expect(bundleNeedles({}).skipped).toContain('YOUTUBE_API_KEY');
  });
});
