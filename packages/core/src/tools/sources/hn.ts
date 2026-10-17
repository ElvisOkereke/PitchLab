import { cleanText, getJson, toDate, type RawItem, type SignalSource } from './types';

interface Hit {
  objectID: string;
  title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  created_at?: string | null;
}

export function createHnSource(): SignalSource {
  return {
    id: 'hn',
    async search(query, { limit, fetchImpl }) {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=${limit}`;
      const json = (await getJson('hn', url, fetchImpl)) as { hits?: Hit[] } | null;
      if (!json || !Array.isArray(json.hits)) return [];
      const items: RawItem[] = json.hits.map((h) => ({
        source: 'hn',
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: cleanText(h.title),
        text: cleanText(h.comment_text ?? h.story_text ?? h.title),
        publishedAt: toDate(h.created_at),
      }));
      return items.slice(0, limit);
    },
  };
}
