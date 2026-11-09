import type { RawItem } from '../../tools/sources/types';
import { youtubeSearch, type YoutubeOpts } from '../sources/youtube';
import { MAX_PER_QUERY } from './common';

/**
 * YouTube Shorts-length videos for a topic query: the existing YouTube source with `videoDuration=short`, so every call
 * goes through its quota guard (a per-day counter shared with missions), its 30-day retention and its comment handling.
 * Items keep source type `youtube`. Few videos and few comments per query keep the quota use small.
 */
export async function ytShortsFeed(q: string, opts: YoutubeOpts): Promise<RawItem[]> {
  const items = await youtubeSearch(q, { ...opts, videoDuration: 'short', maxVideos: 4, commentsPerVideo: 5 });
  return items.slice(0, MAX_PER_QUERY);
}
