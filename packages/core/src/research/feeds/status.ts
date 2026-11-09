import { z } from 'zod';
import type { Db } from '../../db/client';
import { getSetting } from '../../validation/settings';

/** Web-safe (zod and settings only): what the last feeds run did, for Settings → Connections. */
export const FEEDS_STATS_KEY = 'feeds.lastStats';

export const FEED_SOURCES = ['reddit', 'bluesky', 'hnshow', 'arxiv', 'huggingface', 'githubtrending', 'rss', 'ytshorts'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

export const FEED_LABELS: Record<FeedSource, string> = {
  reddit: 'Reddit',
  bluesky: 'Bluesky',
  hnshow: 'Hacker News (Show and Ask)',
  arxiv: 'arXiv',
  huggingface: 'Hugging Face',
  githubtrending: 'GitHub trending',
  rss: 'Newsletters and launch feeds',
  ytshorts: 'YouTube Shorts',
};

const SourceStats = z.object({
  items: z.number().int().min(0).catch(0),
  added: z.number().int().min(0).catch(0),
  errors: z.array(z.string().max(300)).max(10).catch([]),
});
export type FeedSourceStats = z.infer<typeof SourceStats>;

const Stats = z.object({
  at: z.string().max(40),
  spentUsd: z.number().min(0).catch(0),
  bySource: z.record(z.string(), SourceStats),
});
export type FeedsLastStats = z.infer<typeof Stats>;

export type FeedsStatus = { at: string; spentUsd: number; sources: { name: FeedSource; label: string; items: number; added: number; errors: string[] }[] };

/** The last run's stats in a fixed source order, or null when the feeds have not run (or the setting is malformed). */
export async function readFeedsStatus(db: Db): Promise<FeedsStatus | null> {
  const parsed = Stats.safeParse(await getSetting(db, FEEDS_STATS_KEY));
  if (!parsed.success) return null;
  const { at, spentUsd, bySource } = parsed.data;
  return {
    at,
    spentUsd,
    sources: FEED_SOURCES.flatMap((name) => {
      const s = bySource[name];
      return s ? [{ name, label: FEED_LABELS[name], items: s.items, added: s.added, errors: s.errors }] : [];
    }),
  };
}
