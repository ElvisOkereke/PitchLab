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

  it('searches for the sources-expansion secrets when set', () => {
    const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_CHAT_ID', 'SCRAPER_API_KEY', 'BLUESKY_APP_PASSWORD'];
    const { needles } = bundleNeedles(Object.fromEntries(keys.map((k) => [k, `test-only-${k.toLowerCase()}-value`])));
    for (const k of keys) expect(needles.map((n) => n.label)).toContain(k);
    for (const k of keys) expect(bundleNeedles({}).skipped).toContain(k);
  });

  it('has markers for the capture package and its tools, so they never reach the web bundle', () => {
    const labels = bundleNeedles({}).needles.map((n) => n.label);
    for (const m of ['@bcg/capture', 'tesseract', 'yt-dlp', 'playwright']) expect(labels).toContain(`marker ${m}`);
  });
});
